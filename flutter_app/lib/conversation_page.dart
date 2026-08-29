import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'api_client.dart';
import 'models.dart';

class ConversationPage extends StatefulWidget {
  const ConversationPage({
    super.key,
    required this.api,
    required this.isGuest,
    required this.revision,
    required this.onResult,
    required this.onVoiceStart,
    required this.onVoiceStop,
    required this.recording,
    required this.recognizing,
  });

  final ApiClient api;
  final bool isGuest;
  final int revision;
  final Future<void> Function(Map<String, dynamic> result) onResult;
  final VoidCallback onVoiceStart;
  final VoidCallback onVoiceStop;
  final bool recording;
  final bool recognizing;

  @override
  State<ConversationPage> createState() => _ConversationPageState();
}

class _ConversationPageState extends State<ConversationPage> {
  final input = TextEditingController();
  final scroll = ScrollController();
  AiConversation? conversation;
  List<AiConversationMessage> messages = const [];
  bool loading = true;
  bool sending = false;
  String? error;

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
      final conversations = await widget.api.conversations();
      final direct = conversations
          .where((item) => item.type == 'direct_ai')
          .firstOrNull;
      final loaded = direct == null
          ? const <AiConversationMessage>[]
          : await widget.api.conversationMessages(direct.id, limit: 150);
      if (!mounted) return;
      setState(() {
        conversation = direct;
        messages = loaded;
        loading = false;
        error = null;
      });
      _scrollToBottom();
    } catch (exception) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = exception.toString();
      });
    }
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

  Future<void> send() async {
    final text = input.text.trim();
    if (text.isEmpty || sending || widget.isGuest) return;
    FocusScope.of(context).unfocus();
    input.clear();
    setState(() {
      sending = true;
      error = null;
    });
    try {
      final result = await widget.api.ingest(
        text,
        inputMode: 'text',
        onQueued: () => unawaited(load()),
      );
      await load();
      await widget.onResult(result);
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
      await load();
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.isGuest) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(28),
          child: Text(
            '登录后可以保存你与 AI 的每次提问和回答。',
            textAlign: TextAlign.center,
            style: TextStyle(color: Color(0xff8a8680)),
          ),
        ),
      );
    }
    return Column(
      children: [
        Container(
          margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: const Color(0xffffead5),
            borderRadius: BorderRadius.circular(14),
          ),
          child: const Row(
            children: [
              CircleAvatar(
                radius: 15,
                backgroundColor: Color(0xffd97706),
                child: Icon(
                  Icons.auto_awesome_rounded,
                  color: Colors.white,
                  size: 16,
                ),
              ),
              SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '我与 AI',
                      style: TextStyle(fontWeight: FontWeight.w800),
                    ),
                    Text(
                      '仅当前账号可见 · 家庭群将在这里扩展',
                      style: TextStyle(fontSize: 10, color: Color(0xff8f4f0b)),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: Text(
              error!,
              style: const TextStyle(color: Color(0xffb42318), fontSize: 11),
            ),
          ),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator())
              : RefreshIndicator(
                  onRefresh: load,
                  child: messages.isEmpty
                      ? ListView(
                          children: const [
                            SizedBox(height: 90),
                            Icon(
                              Icons.forum_outlined,
                              size: 42,
                              color: Color(0xffc5beb3),
                            ),
                            SizedBox(height: 12),
                            Text(
                              '从这里开始和 AI 对话\n文字和语音问答都会保存在当前账号中',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: Color(0xff8a8680),
                                height: 1.6,
                              ),
                            ),
                          ],
                        )
                      : ListView.builder(
                          controller: scroll,
                          padding: const EdgeInsets.fromLTRB(14, 8, 14, 18),
                          itemCount: messages.length,
                          itemBuilder: (context, index) => _MessageBubble(
                            message: messages[index],
                            showDate:
                                index == 0 ||
                                !DateUtils.isSameDay(
                                  messages[index - 1].createdAt,
                                  messages[index].createdAt,
                                ),
                          ),
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
              Expanded(
                child: TextField(
                  controller: input,
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.newline,
                  decoration: InputDecoration(
                    hintText: '问 AI，或让它记录一件事…',
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
                  backgroundColor: const Color(0xffd97706),
                ),
                icon: sending
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          color: Colors.white,
                          strokeWidth: 2,
                        ),
                      )
                    : const Icon(
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

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.showDate});

  final AiConversationMessage message;
  final bool showDate;

  @override
  Widget build(BuildContext context) {
    final mine = message.isMine;
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
                    const Padding(
                      padding: EdgeInsets.only(bottom: 4),
                      child: Text(
                        'AI 助手',
                        style: TextStyle(
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
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 4,
                            ),
                            decoration: BoxDecoration(
                              color: const Color(0xfffff2df),
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                const Icon(
                                  Icons.description_outlined,
                                  size: 12,
                                  color: Color(0xffb45f06),
                                ),
                                const SizedBox(width: 4),
                                ConstrainedBox(
                                  constraints: const BoxConstraints(
                                    maxWidth: 190,
                                  ),
                                  child: Text(
                                    source['title']?.toString() ?? '资料',
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 10,
                                      color: Color(0xff8f4f0b),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
                    ),
                  ],
                  const SizedBox(height: 4),
                  Text(
                    message.failed
                        ? '处理失败'
                        : message.isPending
                        ? 'AI 正在处理…'
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
