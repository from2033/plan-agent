import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

import 'api_client.dart';
import 'models.dart';
import 'voice_service.dart';

Map<String, dynamic> _documentResult(Map<String, dynamic> document) =>
    Map<String, dynamic>.from(document['result'] as Map? ?? const {});

String _documentTitle(Map<String, dynamic> document) {
  final result = _documentResult(document);
  return (result['title']?.toString().trim().isNotEmpty ?? false)
      ? result['title'].toString().trim()
      : (document['title']?.toString().trim().isNotEmpty ?? false)
      ? document['title'].toString().trim()
      : document['fileName']?.toString() ?? '资料';
}

String _documentCategory(Map<String, dynamic> document) {
  final result = _documentResult(document);
  return result['category']?.toString() ??
      document['category']?.toString() ??
      '文件';
}

class ConversationPage extends StatefulWidget {
  const ConversationPage({
    super.key,
    required this.api,
    required this.isGuest,
    required this.revision,
    required this.onResult,
    required this.onConversationChanged,
    this.initialConversationId,
  });

  final ApiClient api;
  final bool isGuest;
  final int revision;
  final Future<void> Function(Map<String, dynamic> result) onResult;
  final ValueChanged<String?> onConversationChanged;
  final String? initialConversationId;

  @override
  State<ConversationPage> createState() => _ConversationPageState();
}

class _ConversationPageState extends State<ConversationPage> {
  static const documentChannel = MethodChannel(
    'com.from2033.assistant/documents',
  );
  final scaffoldKey = GlobalKey<ScaffoldState>();
  final input = TextEditingController();
  final conversationSearch = TextEditingController();
  final scroll = ScrollController();
  late final VoiceService chatVoice = VoiceService(widget.api);
  List<AiConversation> conversations = const [];
  List<ConversationInvitation> invitations = const [];
  AiConversation? conversation;
  List<AiConversationMessage> messages = const [];
  String currentUser = '';
  bool loading = true;
  bool sending = false;
  bool uploadingAttachment = false;
  bool voiceRecording = false;
  bool voiceTranscribing = false;
  bool pollingPendingMessages = false;
  String? error;
  Timer? pendingMessageTimer;
  Timer? conversationSearchTimer;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  @override
  void didUpdateWidget(covariant ConversationPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.revision != widget.revision) unawaited(load());
  }

  @override
  void dispose() {
    pendingMessageTimer?.cancel();
    conversationSearchTimer?.cancel();
    unawaited(chatVoice.dispose());
    input.dispose();
    conversationSearch.dispose();
    scroll.dispose();
    super.dispose();
  }

  void searchConversations(String value) {
    conversationSearchTimer?.cancel();
    conversationSearchTimer = Timer(
      const Duration(milliseconds: 280),
      () async {
        try {
          final loaded = await widget.api.conversations(query: value);
          if (!mounted || conversationSearch.text != value) return;
          setState(() => conversations = loaded);
        } catch (exception) {
          if (mounted) setState(() => error = exception.toString());
        }
      },
    );
  }

  Future<void> toggleVoice() async {
    if (voiceTranscribing) return;
    if (!voiceRecording) {
      FocusManager.instance.primaryFocus?.unfocus();
      setState(() {
        voiceRecording = true;
        error = null;
      });
      try {
        await chatVoice.start();
      } catch (exception) {
        await chatVoice.cancel();
        if (!mounted) return;
        setState(() {
          voiceRecording = false;
          error = exception.toString();
        });
      }
      return;
    }

    setState(() {
      voiceRecording = false;
      voiceTranscribing = true;
      error = null;
    });
    var backgroundProcessing = false;
    try {
      await chatVoice.beginProcessing();
      backgroundProcessing = true;
      final audio = await chatVoice.stopRecording(
        shortRecordingMessage: '录音太短，请多说一会儿再结束',
      );
      final transcript =
          (await chatVoice
                  .transcribe(audio)
                  .timeout(const Duration(seconds: 30)))
              .trim();
      if (transcript.isEmpty) throw const ApiException('没有识别到内容，请重试');
      if (!mounted) return;
      final existing = input.text.trimRight();
      input.text = existing.isEmpty ? transcript : '$existing $transcript';
      input.selection = TextSelection.collapsed(offset: input.text.length);
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (backgroundProcessing) await chatVoice.endProcessing();
      if (mounted) setState(() => voiceTranscribing = false);
    }
  }

  Future<void> load() async {
    if (widget.isGuest) {
      if (mounted) setState(() => loading = false);
      return;
    }
    try {
      final user = currentUser.isEmpty ? await widget.api.me() : currentUser;
      final loadedConversations = await widget.api.conversations();
      final loadedInvitations = await widget.api.conversationInvitations();
      final selectedId = widget.initialConversationId ?? conversation?.id;
      AiConversation? selected;
      if (selectedId != null) {
        for (final item in loadedConversations) {
          if (item.id == selectedId) selected = item;
        }
      }
      final loadedMessages = selected == null
          ? const <AiConversationMessage>[]
          : await widget.api.conversationMessages(selected.id, limit: 150);
      if (!mounted) return;
      setState(() {
        currentUser = user;
        conversations = loadedConversations;
        invitations = loadedInvitations;
        conversation = selected;
        messages = loadedMessages;
        loading = false;
        error = null;
      });
      _syncPendingMessagePolling();
      if (selected != null) _scrollToBottom();
    } catch (exception) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = exception.toString();
      });
    }
  }

  Future<void> openConversation(AiConversation selected) async {
    setState(() {
      conversation = selected;
      messages = const [];
      loading = true;
      error = null;
    });
    widget.onConversationChanged(selected.id);
    try {
      final loaded = await widget.api.conversationMessages(
        selected.id,
        limit: 150,
      );
      if (!mounted || conversation?.id != selected.id) return;
      setState(() {
        messages = loaded;
        loading = false;
      });
      _syncPendingMessagePolling();
      _scrollToBottom();
    } catch (exception) {
      if (mounted) {
        setState(() {
          loading = false;
          error = exception.toString();
        });
      }
    }
  }

  void closeConversation() {
    pendingMessageTimer?.cancel();
    pendingMessageTimer = null;
    setState(() {
      conversation = null;
      messages = const [];
      sending = false;
      error = null;
    });
    widget.onConversationChanged(null);
    unawaited(load());
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!scroll.hasClients) return;
      scroll.animateTo(
        scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  Future<void> createNewConversation() async {
    try {
      final id = await widget.api.createConversation('新对话');
      final loaded = await widget.api.conversations();
      if (!mounted) return;
      final selected = loaded.firstWhere((item) => item.id == id);
      setState(() => conversations = loaded);
      await openConversation(selected);
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    }
  }

  Future<bool> deleteConversation(AiConversation item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除这段对话？'),
        content: Text('“${item.title}”的聊天记录将不再显示。此操作无法撤销。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            style: FilledButton.styleFrom(
              backgroundColor: const Color(0xffb42318),
            ),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true) return false;
    try {
      await widget.api.deleteConversation(item.id);
      return true;
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
      return false;
    }
  }

  void removeDeletedConversation(AiConversation item) {
    if (conversation?.id == item.id) {
      closeConversation();
      return;
    }
    setState(() {
      conversations = conversations
          .where((conversation) => conversation.id != item.id)
          .toList();
    });
  }

  Future<void> respondInvitation(
    ConversationInvitation invitation,
    bool accept,
  ) async {
    try {
      final id = await widget.api.respondToConversationInvitation(
        invitation.id,
        accept: accept,
      );
      await load();
      if (!accept || id == null || !mounted) return;
      AiConversation? selected;
      for (final item in conversations) {
        if (item.id == id) selected = item;
      }
      if (selected != null) await openConversation(selected);
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    }
  }

  Future<void> manageMembers() async {
    final selected = conversation;
    if (selected == null) return;
    try {
      final results = await Future.wait<dynamic>([
        widget.api.conversationMembers(selected.id),
        widget.api.conversationContacts(),
      ]);
      final members = results[0] as List<Map<String, dynamic>>;
      final existingAccounts = members
          .map((member) => member['userId']?.toString() ?? '')
          .where((account) => account.isNotEmpty)
          .toSet();
      final contacts = (results[1] as List<Map<String, dynamic>>)
          .where(
            (contact) => !existingAccounts.contains(
              contact['account']?.toString() ?? '',
            ),
          )
          .toList();
      if (!mounted) return;
      final account = TextEditingController();
      final selectedAccounts = <String>{};
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => StatefulBuilder(
          builder: (context, setDialogState) => AlertDialog(
            title: const Text('对话成员'),
            content: SizedBox(
              width: 350,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final member in members)
                      ListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        title: Text(member['userId']?.toString() ?? '成员'),
                        trailing: Text(member['role'] == 'owner' ? '群主' : '成员'),
                      ),
                    const Divider(),
                    if (contacts.isNotEmpty) ...[
                      const Text(
                        '直接选择',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      for (final contact in contacts)
                        CheckboxListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          value: selectedAccounts.contains(contact['account']),
                          title: Text(contact['account']?.toString() ?? ''),
                          subtitle: Text(
                            contact['familyMember'] == true ? '家庭成员' : '之前联系过',
                          ),
                          onChanged: (checked) => setDialogState(() {
                            final value = contact['account']?.toString() ?? '';
                            if (checked == true) {
                              selectedAccounts.add(value);
                            } else {
                              selectedAccounts.remove(value);
                            }
                          }),
                        ),
                      const SizedBox(height: 6),
                    ],
                    const Text(
                      '对方接受后，可以查看这段对话已有的消息和已发送资料。',
                      style: TextStyle(fontSize: 12, color: Color(0xffb45f06)),
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      controller: account,
                      keyboardType: TextInputType.emailAddress,
                      decoration: const InputDecoration(
                        labelText: '其他账号（可选）',
                        hintText: '输入对方登录邮箱或账号',
                      ),
                    ),
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext),
                child: const Text('关闭'),
              ),
              FilledButton.icon(
                onPressed: () async {
                  final manual = account.text.trim();
                  final recipients = <String>{
                    ...selectedAccounts,
                    if (manual.isNotEmpty) manual,
                  };
                  if (recipients.isEmpty) return;
                  try {
                    for (final recipient in recipients) {
                      await widget.api.inviteConversationMember(
                        selected.id,
                        recipient,
                      );
                    }
                    if (dialogContext.mounted) Navigator.pop(dialogContext);
                    if (mounted) {
                      ScaffoldMessenger.of(this.context).showSnackBar(
                        SnackBar(
                          content: Text('已向 ${recipients.length} 人发送对话邀请'),
                        ),
                      );
                    }
                  } catch (exception) {
                    if (dialogContext.mounted) {
                      ScaffoldMessenger.of(dialogContext).showSnackBar(
                        SnackBar(content: Text(exception.toString())),
                      );
                    }
                  }
                },
                icon: const Icon(Icons.person_add_alt_1),
                label: const Text('发送邀请'),
              ),
            ],
          ),
        ),
      );
      account.dispose();
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    }
  }

  Future<void> showAttachmentMenu() async {
    FocusManager.instance.primaryFocus?.unfocus();
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.add_photo_alternate_outlined),
              title: const Text('拍照、选择图片或文件'),
              subtitle: const Text('上传后直接加入当前聊天'),
              onTap: () {
                Navigator.pop(sheetContext);
                unawaited(pickAndAttach());
              },
            ),
            ListTile(
              leading: const Icon(Icons.folder_copy_outlined),
              title: const Text('从资料库选择'),
              subtitle: const Text('发送已经保存的文件或知识'),
              onTap: () {
                Navigator.pop(sheetContext);
                unawaited(shareExistingResource());
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Future<void> pickAndAttach() async {
    final selected = conversation;
    if (selected == null || uploadingAttachment) return;
    try {
      final picked = await documentChannel.invokeMapMethod<String, dynamic>(
        'pick',
      );
      if (picked == null || !mounted) return;
      final bytes = picked['bytes'] as Uint8List?;
      final fileName = picked['fileName'] as String? ?? '聊天附件';
      final mimeType =
          picked['mimeType'] as String? ?? 'application/octet-stream';
      if (bytes == null || bytes.isEmpty) throw const ApiException('文件内容为空');
      setState(() {
        uploadingAttachment = true;
        error = null;
      });
      final uploaded = await widget.api.uploadDocument(
        fileName: fileName,
        mimeType: mimeType,
        bytes: bytes,
        note: '从聊天“${selected.title}”上传',
        waitForProcessing: false,
      );
      final documentId = uploaded['documentId'] as String?;
      if (documentId == null || documentId.isEmpty) {
        throw const ApiException('附件上传成功，但没有取得资料编号');
      }
      await widget.api.addConversationResource(
        selected.id,
        'document',
        documentId,
      );
      await _reloadMessages();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('已发送附件：$fileName')));
      }
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (mounted) setState(() => uploadingAttachment = false);
    }
  }

  Future<void> shareExistingResource() async {
    final selected = conversation;
    if (selected == null) return;
    FocusManager.instance.primaryFocus?.unfocus();
    try {
      final documents = await widget.api.documents();
      final knowledge = await widget.api.knowledge();
      if (!mounted) return;
      var shared = false;
      var query = '';
      await showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (sheetContext) => StatefulBuilder(
          builder: (context, setSheetState) {
            final needle = query.trim().toLowerCase();
            final visibleDocuments = documents.where((item) {
              if (item['canEdit'] == false) return false;
              final text = '${_documentTitle(item)} ${_documentCategory(item)}'
                  .toLowerCase();
              return needle.isEmpty || text.contains(needle);
            }).toList();
            final visibleKnowledge = knowledge.where((item) {
              if (!item.canEdit) return false;
              final text = '${item.title} ${item.content}'.toLowerCase();
              return needle.isEmpty || text.contains(needle);
            }).toList();
            return SafeArea(
              child: SizedBox(
                height: MediaQuery.sizeOf(context).height * .72,
                child: Column(
                  children: [
                    const ListTile(
                      title: Text(
                        '发送资料',
                        style: TextStyle(fontWeight: FontWeight.w800),
                      ),
                      subtitle: Text('发送即共享，当前和以后进入该对话的成员都可以查看'),
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                      child: TextField(
                        decoration: const InputDecoration(
                          hintText: '搜索资料标题或内容',
                          prefixIcon: Icon(Icons.search_rounded),
                        ),
                        onTapOutside: (_) =>
                            FocusManager.instance.primaryFocus?.unfocus(),
                        onChanged: (value) =>
                            setSheetState(() => query = value),
                      ),
                    ),
                    Expanded(
                      child: ListView(
                        children: [
                          if (visibleDocuments.isNotEmpty)
                            const _SectionLabel('文件资料'),
                          for (final document in visibleDocuments)
                            ListTile(
                              leading: const Icon(Icons.description_outlined),
                              title: Text(_documentTitle(document)),
                              subtitle: Text(_documentCategory(document)),
                              onTap: () async {
                                await widget.api.addConversationResource(
                                  selected.id,
                                  'document',
                                  document['id'] as String,
                                );
                                shared = true;
                                if (sheetContext.mounted) {
                                  Navigator.pop(sheetContext);
                                }
                              },
                            ),
                          if (visibleKnowledge.isNotEmpty)
                            const _SectionLabel('知识记录'),
                          for (final item in visibleKnowledge)
                            ListTile(
                              leading: const Icon(Icons.notes_rounded),
                              title: Text(item.title),
                              subtitle: Text(
                                item.content,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              onTap: () async {
                                await widget.api.addConversationResource(
                                  selected.id,
                                  'knowledge',
                                  item.id,
                                );
                                shared = true;
                                if (sheetContext.mounted) {
                                  Navigator.pop(sheetContext);
                                }
                              },
                            ),
                          if (visibleDocuments.isEmpty &&
                              visibleKnowledge.isEmpty)
                            const Padding(
                              padding: EdgeInsets.all(32),
                              child: Text(
                                '没有找到匹配的资料',
                                textAlign: TextAlign.center,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      );
      if (shared && mounted) {
        await _reloadMessages();
        if (!mounted) return;
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('资料已发送到当前对话，群成员均可查看')));
      }
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    }
  }

  Future<void> send() async {
    final selected = conversation;
    final text = input.text.trim();
    if (selected == null || text.isEmpty || sending || widget.isGuest) return;
    FocusScope.of(context).unfocus();
    input.clear();
    setState(() {
      sending = true;
      error = null;
    });
    _scrollToBottom();
    try {
      final result = await widget.api.ingest(
        text,
        inputMode: 'text',
        conversationId: selected.id,
        waitForCompletion: false,
        onQueued: () => unawaited(_reloadMessages()),
      );
      await _reloadMessages();
      if (result['kind'] != 'pending') await widget.onResult(result);
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
      await _reloadMessages();
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  Future<void> _reloadMessages() async {
    final selected = conversation;
    if (selected == null) return;
    final hadPending = messages.any((item) => item.isPending);
    final loaded = await widget.api.conversationMessages(
      selected.id,
      limit: 150,
    );
    if (!mounted || conversation?.id != selected.id) return;
    setState(() => messages = loaded);
    _syncPendingMessagePolling();
    _scrollToBottom();
    if (hadPending && !loaded.any((item) => item.isPending)) {
      unawaited(widget.onResult(const {'kind': 'conversation_complete'}));
    }
  }

  void _syncPendingMessagePolling() {
    final shouldPoll =
        conversation != null && messages.any((item) => item.isPending);
    if (!shouldPoll) {
      pendingMessageTimer?.cancel();
      pendingMessageTimer = null;
      return;
    }
    pendingMessageTimer ??= Timer.periodic(const Duration(seconds: 3), (
      _,
    ) async {
      if (pollingPendingMessages || !mounted) return;
      pollingPendingMessages = true;
      try {
        await _reloadMessages();
      } catch (_) {
        // A temporary refresh failure must not hide a server-side AI task.
      } finally {
        pollingPendingMessages = false;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    if (widget.isGuest) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(28),
          child: Text('登录后可以新建对话，并邀请家人一起使用 AI。', textAlign: TextAlign.center),
        ),
      );
    }
    return Scaffold(
      key: scaffoldKey,
      backgroundColor: Colors.transparent,
      drawer: Drawer(
        backgroundColor: const Color(0xfffbfaf7),
        child: SafeArea(child: _buildConversationList()),
      ),
      body: conversation == null
          ? _buildEmptyConversation()
          : _buildConversationDetail(),
    );
  }

  Widget _buildEmptyConversation() => Column(
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(8, 2, 12, 8),
        child: Row(
          children: [
            IconButton(
              onPressed: () => scaffoldKey.currentState?.openDrawer(),
              tooltip: '聊天记录',
              icon: const Icon(Icons.menu_rounded),
            ),
            const Expanded(
              child: Text('新对话', style: TextStyle(fontWeight: FontWeight.w800)),
            ),
            IconButton(
              onPressed: createNewConversation,
              tooltip: '新建对话',
              icon: const Icon(Icons.edit_square),
            ),
          ],
        ),
      ),
      Expanded(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.auto_awesome_rounded,
                  size: 42,
                  color: Color(0xffd97706),
                ),
                const SizedBox(height: 14),
                const Text(
                  '开始一段新对话',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 6),
                const Text(
                  '聊天记录收在左侧，随时可以回来继续。',
                  style: TextStyle(color: Color(0xff8a8680)),
                ),
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: createNewConversation,
                  icon: const Icon(Icons.add_comment_outlined),
                  label: const Text('新建聊天'),
                ),
              ],
            ),
          ),
        ),
      ),
    ],
  );

  Widget _buildConversationList() => Column(
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 10, 8),
        child: Row(
          children: [
            const Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '所有对话',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                  ),
                  Text(
                    '私人 AI、专题对话和家庭群聊',
                    style: TextStyle(fontSize: 11, color: Color(0xff8a8680)),
                  ),
                ],
              ),
            ),
            IconButton.filled(
              onPressed: createNewConversation,
              tooltip: '新建对话',
              icon: const Icon(Icons.add_comment_outlined),
            ),
          ],
        ),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
        child: TextField(
          controller: conversationSearch,
          onChanged: searchConversations,
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            isDense: true,
            hintText: '搜索对话标题和聊天内容',
            prefixIcon: const Icon(Icons.search_rounded, size: 20),
            suffixIcon: conversationSearch.text.isEmpty
                ? null
                : IconButton(
                    tooltip: '清空搜索',
                    onPressed: () {
                      conversationSearch.clear();
                      searchConversations('');
                      setState(() {});
                    },
                    icon: const Icon(Icons.close_rounded, size: 18),
                  ),
            filled: true,
            fillColor: const Color(0xfff3f0eb),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(14),
              borderSide: BorderSide.none,
            ),
          ),
        ),
      ),
      if (error != null) _ErrorText(error!),
      Expanded(
        child: loading
            ? const Center(child: CircularProgressIndicator())
            : RefreshIndicator(
                onRefresh: load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                  children: [
                    for (final invitation in invitations)
                      Card(
                        color: const Color(0xfffff2df),
                        child: ListTile(
                          leading: const Icon(
                            Icons.mark_email_unread_outlined,
                            color: Color(0xffb45f06),
                          ),
                          title: Text('${invitation.invitedBy} 邀请你加入'),
                          subtitle: Text(invitation.conversationTitle),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                onPressed: () =>
                                    respondInvitation(invitation, false),
                                icon: const Icon(Icons.close),
                              ),
                              IconButton.filled(
                                onPressed: () =>
                                    respondInvitation(invitation, true),
                                icon: const Icon(Icons.check),
                              ),
                            ],
                          ),
                        ),
                      ),
                    if (conversations.isEmpty &&
                        conversationSearch.text.isNotEmpty)
                      const Padding(
                        padding: EdgeInsets.only(top: 36),
                        child: Text('没有找到相关对话', textAlign: TextAlign.center),
                      ),
                    for (final item in conversations)
                      Dismissible(
                        key: ValueKey('conversation-${item.id}'),
                        direction: DismissDirection.endToStart,
                        confirmDismiss: (_) => deleteConversation(item),
                        onDismissed: (_) => removeDeletedConversation(item),
                        background: Container(
                          alignment: Alignment.centerRight,
                          padding: const EdgeInsets.only(right: 18),
                          color: const Color(0xffb42318),
                          child: const Row(
                            mainAxisAlignment: MainAxisAlignment.end,
                            children: [
                              Icon(
                                Icons.delete_outline_rounded,
                                color: Colors.white,
                              ),
                              SizedBox(width: 7),
                              Text(
                                '删除',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ],
                          ),
                        ),
                        child: ListTile(
                          dense: true,
                          visualDensity: const VisualDensity(vertical: -2),
                          contentPadding: const EdgeInsets.only(
                            left: 10,
                            right: 12,
                          ),
                          onTap: () {
                            Navigator.of(context).pop();
                            unawaited(openConversation(item));
                          },
                          title: Text(
                            item.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 13.5,
                              height: 1.25,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
      ),
    ],
  );

  Widget _buildConversationDetail() {
    final selected = conversation!;
    final showThinking = sending || messages.any((item) => item.isPending);
    return Column(
      children: [
        Container(
          margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 5),
          decoration: BoxDecoration(
            color: const Color(0xffffead5),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            children: [
              IconButton(
                onPressed: () => scaffoldKey.currentState?.openDrawer(),
                tooltip: '聊天记录',
                icon: const Icon(Icons.menu_rounded),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      selected.title,
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                    Text(
                      selected.memberCount > 1
                          ? '${selected.memberCount} 位成员 · 只使用群资料'
                          : '仅当前账号可见',
                      style: const TextStyle(
                        fontSize: 10,
                        color: Color(0xff8f4f0b),
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                onPressed: manageMembers,
                tooltip: '成员',
                icon: const Icon(Icons.group_add_outlined),
              ),
            ],
          ),
        ),
        if (error != null) _ErrorText(error!),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: _reloadMessages,
                  child: messages.isEmpty && !showThinking
                      ? ListView(
                          keyboardDismissBehavior:
                              ScrollViewKeyboardDismissBehavior.onDrag,
                          children: const [
                            SizedBox(height: 90),
                            Icon(
                              Icons.forum_outlined,
                              size: 42,
                              color: Color(0xffc5beb3),
                            ),
                            SizedBox(height: 12),
                            Text(
                              '从这里开始对话\n需要协作时可中途邀请成员或发送资料',
                              textAlign: TextAlign.center,
                            ),
                          ],
                        )
                      : ListView.builder(
                          controller: scroll,
                          keyboardDismissBehavior:
                              ScrollViewKeyboardDismissBehavior.onDrag,
                          padding: const EdgeInsets.fromLTRB(14, 8, 14, 18),
                          itemCount: messages.length + (showThinking ? 1 : 0),
                          itemBuilder: (context, index) {
                            if (index == messages.length) {
                              return const _ThinkingBubble();
                            }
                            final message = messages[index];
                            return _MessageBubble(
                              message: message,
                              currentUser: currentUser,
                              showDate:
                                  index == 0 ||
                                  !DateUtils.isSameDay(
                                    messages[index - 1].createdAt,
                                    message.createdAt,
                                  ),
                            );
                          },
                        ),
                ),
        ),
        Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          decoration: const BoxDecoration(
            color: Color(0xfffbfaf7),
            border: Border(top: BorderSide(color: Color(0xffe7e1d8))),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              IconButton(
                onPressed: uploadingAttachment ? null : showAttachmentMenu,
                tooltip: '添加图片或文件',
                icon: uploadingAttachment
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.add_circle_outline_rounded),
              ),
              Expanded(
                child: TextField(
                  controller: input,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    hintText: voiceRecording
                        ? '正在录音，再点一次麦克风结束'
                        : voiceTranscribing
                        ? '正在识别语音…'
                        : '发消息，或让 AI 查群资料…',
                    filled: true,
                    fillColor: Colors.white,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 11,
                    ),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(18),
                      borderSide: BorderSide.none,
                    ),
                  ),
                  onTapOutside: (_) =>
                      FocusManager.instance.primaryFocus?.unfocus(),
                  onSubmitted: (_) => send(),
                ),
              ),
              const SizedBox(width: 7),
              IconButton(
                onPressed: voiceTranscribing ? null : toggleVoice,
                tooltip: voiceRecording ? '结束录音' : '语音输入',
                style: IconButton.styleFrom(
                  fixedSize: const Size.square(44),
                  backgroundColor: voiceRecording
                      ? const Color(0xffffdada)
                      : const Color(0xffede9e1),
                ),
                icon: voiceTranscribing
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(
                        voiceRecording ? Icons.stop_rounded : Icons.mic_rounded,
                        color: voiceRecording
                            ? const Color(0xffdc2626)
                            : const Color(0xff8a8680),
                      ),
              ),
              const SizedBox(width: 7),
              IconButton.filled(
                onPressed: sending ? null : send,
                style: IconButton.styleFrom(
                  backgroundColor: sending
                      ? const Color(0xffd8d2c9)
                      : const Color(0xffd97706),
                ),
                icon: const Icon(
                  Icons.arrow_upward_rounded,
                  color: Colors.white,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ThinkingBubble extends StatelessWidget {
  const _ThinkingBubble();

  @override
  Widget build(BuildContext context) => const Align(
    alignment: Alignment.centerLeft,
    child: Card(
      margin: EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 13, vertical: 11),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            SizedBox(width: 9),
            Text('助手正在思考…', style: TextStyle(color: Color(0xff8a8680))),
          ],
        ),
      ),
    ),
  );
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.message,
    required this.currentUser,
    required this.showDate,
  });
  final AiConversationMessage message;
  final String currentUser;
  final bool showDate;

  @override
  Widget build(BuildContext context) {
    if (message.senderType == 'system') {
      return Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Text(
            message.content,
            style: const TextStyle(fontSize: 10, color: Color(0xff9b968e)),
          ),
        ),
      );
    }
    final mine = message.isMineFor(currentUser);
    final isPerson = message.senderType == 'user';
    final sources = (message.metadata['sources'] as List<dynamic>? ?? const [])
        .whereType<Map>()
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
    return Column(
      children: [
        if (showDate)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Text(
              DateFormat('M月d日 EEEE', 'zh_CN').format(message.createdAt),
              style: const TextStyle(fontSize: 10, color: Color(0xff9b968e)),
            ),
          ),
        Align(
          alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.sizeOf(context).width * .78,
            ),
            child: Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.fromLTRB(13, 10, 13, 8),
              decoration: BoxDecoration(
                color: mine
                    ? const Color(0xffffdfb8)
                    : message.kind == 'action'
                    ? const Color(0xffeeeae4)
                    : Colors.white,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(17),
                  topRight: const Radius.circular(17),
                  bottomLeft: Radius.circular(mine ? 17 : 4),
                  bottomRight: Radius.circular(mine ? 4 : 17),
                ),
                border: Border.all(color: const Color(0xffe5ded4)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (!mine)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        isPerson ? (message.senderUserId ?? '家庭成员') : 'AI 助手',
                        style: const TextStyle(
                          color: Color(0xffb45f06),
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  SelectableText(
                    message.content,
                    style: const TextStyle(
                      fontSize: 14,
                      height: 1.48,
                      color: Color(0xff272522),
                    ),
                  ),
                  if (sources.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 5,
                      children: [
                        for (final source in sources)
                          Chip(
                            visualDensity: VisualDensity.compact,
                            avatar: const Icon(
                              Icons.description_outlined,
                              size: 13,
                            ),
                            label: Text(
                              source['title']?.toString() ?? '资料',
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                    ),
                  ],
                  const SizedBox(height: 4),
                  Text(
                    message.failed
                        ? '处理失败'
                        : DateFormat('HH:mm').format(message.createdAt),
                    style: TextStyle(
                      fontSize: 9,
                      color: message.failed
                          ? const Color(0xffb42318)
                          : const Color(0xff9b968e),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
    child: Text(
      text,
      style: const TextStyle(
        fontSize: 12,
        fontWeight: FontWeight.w800,
        color: Color(0xff8a8680),
      ),
    ),
  );
}

class _ErrorText extends StatelessWidget {
  const _ErrorText(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
    child: Text(
      text,
      style: const TextStyle(color: Color(0xffb42318), fontSize: 11),
    ),
  );
}
