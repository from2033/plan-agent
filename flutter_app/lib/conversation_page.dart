import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'api_client.dart';
import 'models.dart';

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
    required this.onVoiceStart,
    required this.onVoiceStop,
    required this.onConversationChanged,
    required this.externalThinking,
    required this.recording,
    required this.recognizing,
    this.initialConversationId,
  });

  final ApiClient api;
  final bool isGuest;
  final int revision;
  final Future<void> Function(Map<String, dynamic> result) onResult;
  final VoidCallback onVoiceStart;
  final VoidCallback onVoiceStop;
  final ValueChanged<String?> onConversationChanged;
  final bool externalThinking;
  final bool recording;
  final bool recognizing;
  final String? initialConversationId;

  @override
  State<ConversationPage> createState() => _ConversationPageState();
}

class _ConversationPageState extends State<ConversationPage> {
  final scaffoldKey = GlobalKey<ScaffoldState>();
  final input = TextEditingController();
  final scroll = ScrollController();
  List<AiConversation> conversations = const [];
  List<ConversationInvitation> invitations = const [];
  AiConversation? conversation;
  List<AiConversationMessage> messages = const [];
  String currentUser = '';
  bool loading = true;
  bool sending = false;
  bool pollingPendingMessages = false;
  String? error;
  Timer? pendingMessageTimer;

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
    input.dispose();
    scroll.dispose();
    super.dispose();
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

  Future<void> deleteConversation(AiConversation item) async {
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
    if (confirmed != true) return;
    try {
      await widget.api.deleteConversation(item.id);
      if (!mounted) return;
      if (conversation?.id == item.id) closeConversation();
      await load();
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    }
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
      final members = await widget.api.conversationMembers(selected.id);
      if (!mounted) return;
      final account = TextEditingController();
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('对话成员'),
          content: SizedBox(
            width: 330,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final member in members)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: const CircleAvatar(
                      child: Icon(Icons.person_outline, size: 18),
                    ),
                    title: Text(member['userId']?.toString() ?? '成员'),
                    trailing: Text(member['role'] == 'owner' ? '群主' : '成员'),
                  ),
                const Divider(),
                const Text(
                  '对方接受后，可以查看这段对话已有的消息和已发送资料。',
                  style: TextStyle(fontSize: 12, color: Color(0xffb45f06)),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: account,
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(
                    labelText: '邀请账号',
                    hintText: '输入对方登录邮箱或账号',
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('关闭'),
            ),
            FilledButton.icon(
              onPressed: () async {
                final value = account.text.trim();
                if (value.isEmpty) return;
                try {
                  await widget.api.inviteConversationMember(selected.id, value);
                  if (dialogContext.mounted) Navigator.pop(dialogContext);
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('邀请已发送，对方接受后即可进入群聊')),
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
              label: const Text('邀请'),
            ),
          ],
        ),
      );
      account.dispose();
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    }
  }

  Future<void> shareResource() async {
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
                    for (final item in conversations)
                      Card(
                        child: ListTile(
                          onTap: () {
                            Navigator.of(context).pop();
                            unawaited(openConversation(item));
                          },
                          leading: CircleAvatar(
                            backgroundColor: item.type == 'direct_ai'
                                ? const Color(0xffffead5)
                                : const Color(0xffe8efe7),
                            child: Icon(
                              item.memberCount > 1
                                  ? Icons.groups_2_outlined
                                  : Icons.auto_awesome_rounded,
                              color: item.type == 'direct_ai'
                                  ? const Color(0xffd97706)
                                  : const Color(0xff4f7252),
                            ),
                          ),
                          title: Text(
                            item.title,
                            style: const TextStyle(fontWeight: FontWeight.w700),
                          ),
                          subtitle: Text(
                            item.memberCount > 1
                                ? '${item.memberCount} 位成员 · AI 在群内协助'
                                : '私人对话 · 仅你与 AI 可见',
                            style: const TextStyle(fontSize: 11),
                          ),
                          trailing: PopupMenuButton<String>(
                            tooltip: '对话操作',
                            onSelected: (value) {
                              if (value == 'delete') {
                                unawaited(deleteConversation(item));
                              }
                            },
                            itemBuilder: (_) => const [
                              PopupMenuItem(
                                value: 'delete',
                                child: Row(
                                  children: [
                                    Icon(
                                      Icons.delete_outline_rounded,
                                      color: Color(0xffb42318),
                                    ),
                                    SizedBox(width: 9),
                                    Text('删除对话'),
                                  ],
                                ),
                              ),
                            ],
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
    final showThinking =
        sending ||
        widget.externalThinking ||
        messages.any((item) => item.isPending);
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
                onPressed: shareResource,
                tooltip: '发送资料',
                icon: const Icon(Icons.add_circle_outline_rounded),
              ),
              Expanded(
                child: TextField(
                  controller: input,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    hintText: '发消息，或让 AI 查群资料…',
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
              Listener(
                onPointerDown: (_) => widget.onVoiceStart(),
                onPointerUp: (_) => widget.onVoiceStop(),
                onPointerCancel: (_) => widget.onVoiceStop(),
                child: CircleAvatar(
                  radius: 22,
                  backgroundColor: widget.recording
                      ? const Color(0xffffdada)
                      : const Color(0xffede9e1),
                  child: widget.recognizing
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Icon(
                          widget.recording
                              ? Icons.graphic_eq_rounded
                              : Icons.mic_rounded,
                          color: widget.recording
                              ? const Color(0xffdc2626)
                              : const Color(0xff8a8680),
                        ),
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
