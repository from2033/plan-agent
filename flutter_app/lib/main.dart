import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter/services.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api_client.dart';
import 'models.dart';
import 'reminder_service.dart';
import 'voice_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  await initializeDateFormatting('zh_CN');
  runApp(const AssistantApp());
}

class AssistantApp extends StatefulWidget {
  const AssistantApp({super.key});

  @override
  State<AssistantApp> createState() => _AssistantAppState();
}

class _AssistantAppState extends State<AssistantApp> {
  final ApiClient api = ApiClient();
  SessionMode? sessionMode;

  @override
  void initState() {
    super.initState();
    api.restoreSession().then((value) {
      if (mounted) setState(() => sessionMode = value);
    });
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Personal Assistant',
      debugShowCheckedModeBanner: false,
      locale: const Locale('zh', 'CN'),
      supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xffd97706)),
        scaffoldBackgroundColor: const Color(0xfff5f4f0),
        useMaterial3: true,
        fontFamilyFallback: const ['PingFang SC', 'Helvetica Neue'],
      ),
      home: sessionMode == null
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : sessionMode == SessionMode.signedIn ||
                sessionMode == SessionMode.guest
          ? HomeScreen(
              api: api,
              isGuest: sessionMode == SessionMode.guest,
              onLogin: () =>
                  setState(() => sessionMode = SessionMode.signedOut),
              onLogout: () =>
                  setState(() => sessionMode = SessionMode.signedOut),
            )
          : LoginScreen(
              api: api,
              onSignedIn: () =>
                  setState(() => sessionMode = SessionMode.signedIn),
              onContinueAsGuest: () =>
                  setState(() => sessionMode = SessionMode.guest),
            ),
    );
  }
}

class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.api,
    required this.onSignedIn,
    required this.onContinueAsGuest,
  });
  final ApiClient api;
  final VoidCallback onSignedIn;
  final VoidCallback onContinueAsGuest;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final email = TextEditingController();
  final code = TextEditingController();
  bool codeSent = false;
  bool busy = false;
  String? error;

  Future<void> submit() async {
    final address = email.text.trim();
    if (!address.contains('@') || !address.contains('.')) {
      setState(() => error = '请输入有效的邮箱地址');
      return;
    }
    if (codeSent && code.text.trim().length != 6) {
      setState(() => error = '请输入 6 位验证码');
      return;
    }
    setState(() {
      busy = true;
      error = null;
    });
    try {
      if (!codeSent) {
        await widget.api.requestEmailCode(address);
        setState(() => codeSent = true);
      } else {
        final migrated = await widget.api.verifyEmailCode(
          address,
          code.text.trim(),
        );
        if (!migrated && mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('已登录；访客数据将在下次启动时继续迁移')));
        }
        widget.onSignedIn();
      }
    } catch (e) {
      setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> continueAsGuest() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.api.startGuestSession();
      widget.onContinueAsGuest();
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    const ink = Color(0xff1e1d1a);
    const muted = Color(0xff77736c);
    const paper = Color(0xfff7f5ef);
    const accent = Color(0xffdc7a32);

    InputDecoration fieldDecoration({
      required String hint,
      required IconData icon,
    }) {
      return InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Color(0xffaaa59c)),
        prefixIcon: Icon(icon, color: const Color(0xff77736c), size: 20),
        filled: true,
        fillColor: const Color(0xfff3f1eb),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 16,
          vertical: 18,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(15),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(15),
          borderSide: const BorderSide(color: Color(0xffebe7de)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(15),
          borderSide: const BorderSide(color: accent, width: 1.5),
        ),
      );
    }

    return Scaffold(
      backgroundColor: paper,
      body: Stack(
        children: [
          Positioned(
            top: -135,
            right: -105,
            child: Container(
              width: 300,
              height: 300,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: accent.withValues(alpha: .12),
              ),
            ),
          ),
          Positioned(
            top: 120,
            right: 28,
            child: Container(
              width: 10,
              height: 10,
              decoration: const BoxDecoration(
                shape: BoxShape.circle,
                color: accent,
              ),
            ),
          ),
          SafeArea(
            child: LayoutBuilder(
              builder: (context, viewport) => SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(26, 24, 26, 22),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minHeight: viewport.maxHeight - 46,
                    maxWidth: 460,
                  ),
                  child: IntrinsicHeight(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            Container(
                              width: 38,
                              height: 38,
                              decoration: BoxDecoration(
                                color: ink,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: const Icon(
                                Icons.graphic_eq_rounded,
                                color: Colors.white,
                                size: 21,
                              ),
                            ),
                            const SizedBox(width: 11),
                            const Text(
                              'Daynote',
                              style: TextStyle(
                                color: ink,
                                fontSize: 13,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.8,
                              ),
                            ),
                          ],
                        ),
                        const Spacer(),
                        const Text(
                          '把一天，\n说清楚。',
                          style: TextStyle(
                            color: ink,
                            fontSize: 40,
                            height: 1.12,
                            letterSpacing: -1.2,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        const SizedBox(height: 14),
                        const Text(
                          '说一句，自动整理行程、账单和待办。',
                          style: TextStyle(
                            color: muted,
                            fontSize: 15,
                            height: 1.5,
                          ),
                        ),
                        const SizedBox(height: 34),
                        Container(
                          padding: const EdgeInsets.all(20),
                          decoration: BoxDecoration(
                            color: Colors.white.withValues(alpha: .92),
                            borderRadius: BorderRadius.circular(24),
                            border: Border.all(color: const Color(0xffebe7de)),
                            boxShadow: [
                              BoxShadow(
                                color: ink.withValues(alpha: .055),
                                blurRadius: 28,
                                offset: const Offset(0, 12),
                              ),
                            ],
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Text(
                                codeSent ? '输入验证码' : '邮箱登录',
                                style: const TextStyle(
                                  color: ink,
                                  fontSize: 18,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              const SizedBox(height: 6),
                              Text(
                                codeSent
                                    ? '验证码已发送，10 分钟内有效'
                                    : '无需密码，我们会发送一次性验证码',
                                style: const TextStyle(
                                  color: muted,
                                  fontSize: 12.5,
                                ),
                              ),
                              const SizedBox(height: 18),
                              TextField(
                                controller: email,
                                enabled: !codeSent,
                                keyboardType: TextInputType.emailAddress,
                                textInputAction: codeSent
                                    ? TextInputAction.next
                                    : TextInputAction.done,
                                autofillHints: const [AutofillHints.email],
                                autocorrect: false,
                                decoration: fieldDecoration(
                                  hint: 'name@example.com',
                                  icon: Icons.alternate_email_rounded,
                                ),
                                onSubmitted: (_) {
                                  if (!codeSent) submit();
                                },
                              ),
                              if (codeSent) ...[
                                const SizedBox(height: 12),
                                TextField(
                                  controller: code,
                                  keyboardType: TextInputType.number,
                                  textInputAction: TextInputAction.done,
                                  autofillHints: const [
                                    AutofillHints.oneTimeCode,
                                  ],
                                  maxLength: 6,
                                  decoration: fieldDecoration(
                                    hint: '6 位验证码',
                                    icon: Icons.lock_outline_rounded,
                                  ).copyWith(counterText: ''),
                                  onSubmitted: (_) => submit(),
                                ),
                              ],
                              AnimatedSize(
                                duration: const Duration(milliseconds: 180),
                                child: error == null
                                    ? const SizedBox.shrink()
                                    : Container(
                                        margin: const EdgeInsets.only(top: 12),
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 12,
                                          vertical: 10,
                                        ),
                                        decoration: BoxDecoration(
                                          color: const Color(0xfffff1ec),
                                          borderRadius: BorderRadius.circular(
                                            11,
                                          ),
                                        ),
                                        child: Row(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            const Icon(
                                              Icons.info_outline_rounded,
                                              size: 17,
                                              color: Color(0xffb94f2b),
                                            ),
                                            const SizedBox(width: 8),
                                            Expanded(
                                              child: Text(
                                                error!,
                                                style: const TextStyle(
                                                  color: Color(0xff8f3f25),
                                                  fontSize: 12.5,
                                                  height: 1.35,
                                                ),
                                              ),
                                            ),
                                          ],
                                        ),
                                      ),
                              ),
                              const SizedBox(height: 16),
                              FilledButton(
                                onPressed: busy ? null : submit,
                                style: FilledButton.styleFrom(
                                  minimumSize: const Size.fromHeight(54),
                                  backgroundColor: ink,
                                  foregroundColor: Colors.white,
                                  disabledBackgroundColor: ink.withValues(
                                    alpha: .55,
                                  ),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(15),
                                  ),
                                ),
                                child: busy
                                    ? const SizedBox.square(
                                        dimension: 20,
                                        child: CircularProgressIndicator(
                                          color: Colors.white,
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : Row(
                                        mainAxisAlignment:
                                            MainAxisAlignment.center,
                                        children: [
                                          Text(codeSent ? '验证并登录' : '获取验证码'),
                                          const SizedBox(width: 8),
                                          const Icon(
                                            Icons.arrow_forward_rounded,
                                            size: 18,
                                          ),
                                        ],
                                      ),
                              ),
                              if (codeSent)
                                TextButton(
                                  onPressed: busy
                                      ? null
                                      : () => setState(() {
                                          codeSent = false;
                                          code.clear();
                                          error = null;
                                        }),
                                  child: const Text('更换邮箱'),
                                ),
                              const Padding(
                                padding: EdgeInsets.symmetric(vertical: 8),
                                child: Row(
                                  children: [
                                    Expanded(child: Divider()),
                                    Padding(
                                      padding: EdgeInsets.symmetric(
                                        horizontal: 12,
                                      ),
                                      child: Text(
                                        '或者',
                                        style: TextStyle(
                                          color: Color(0xffaaa59c),
                                          fontSize: 12,
                                        ),
                                      ),
                                    ),
                                    Expanded(child: Divider()),
                                  ],
                                ),
                              ),
                              OutlinedButton.icon(
                                onPressed: busy ? null : continueAsGuest,
                                style: OutlinedButton.styleFrom(
                                  minimumSize: const Size.fromHeight(50),
                                  foregroundColor: ink,
                                  side: const BorderSide(
                                    color: Color(0xffd8d2c8),
                                  ),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(15),
                                  ),
                                ),
                                icon: const Icon(
                                  Icons.person_outline_rounded,
                                  size: 19,
                                ),
                                label: const Text('暂不登录，先体验'),
                              ),
                              const SizedBox(height: 8),
                              const Text(
                                '访客记录保存在本机；登录后会自动迁移并同步到云端',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  color: Color(0xff99948b),
                                  fontSize: 11,
                                  height: 1.4,
                                ),
                              ),
                            ],
                          ),
                        ),
                        const Spacer(),
                        Padding(
                          padding: const EdgeInsets.only(top: 24),
                          child: TextButton(
                            onPressed: () => launchUrl(
                              Uri.parse('https://assistant.5656ai.com/privacy'),
                              mode: LaunchMode.externalApplication,
                            ),
                            child: const Text(
                              '继续使用即表示你已阅读《隐私政策》',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: Color(0xff8f704f),
                                fontSize: 11,
                                decoration: TextDecoration.underline,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PendingVoiceTask {
  _PendingVoiceTask({required this.id, required this.text});

  final int id;
  String text;
  String status = '等待处理';
  String? errorMessage;

  bool get failed => errorMessage != null;
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.api,
    required this.isGuest,
    required this.onLogin,
    required this.onLogout,
  });
  final ApiClient api;
  final bool isGuest;
  final VoidCallback onLogin;
  final VoidCallback onLogout;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late final VoiceService voice = VoiceService(widget.api);
  final ReminderService reminders = ReminderService();
  List<AssistantEntry> entries = [];
  int tab = 0;
  bool loading = true;
  bool recording = false;
  bool recognizing = false;
  String? error;
  Set<String> scheduledReminderIds = {};
  final List<_PendingVoiceTask> pendingTasks = [];
  int _nextPendingId = 1;
  int _knowledgeRevision = 0;
  DateTime selectedDate = DateUtils.dateOnly(DateTime.now());
  Future<void>? _voiceStart;
  DateTime? _pressStartedAt;
  bool _voiceReady = false;
  bool _disposing = false;
  bool deletingAccount = false;

  static const List<(EntryType?, String, IconData)> tabs = [
    (EntryType.activity, '行程', Icons.schedule_rounded),
    (EntryType.expense, '账单', Icons.credit_card_rounded),
    (EntryType.memo, '备忘', Icons.book_outlined),
    (EntryType.wish, '心愿', Icons.star_outline_rounded),
    (null, '知识', Icons.lightbulb_outline_rounded),
  ];

  @override
  void initState() {
    super.initState();
    refresh();
  }

  Future<void> refresh() async {
    try {
      final value = await widget.api.entries();
      if (mounted) {
        setState(() {
          entries = value;
          error = null;
        });
        unawaited(_syncReminders(value));
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _syncReminders(List<AssistantEntry> value) async {
    try {
      final result = await reminders.sync(value);
      if (mounted) {
        setState(() {
          scheduledReminderIds = result.scheduledEntryIds;
          if (result.mode == 'denied') {
            error = '备忘已保存，但系统未允许闹钟或通知，请到“设置”中开启权限';
          }
        });
      }
    } catch (_) {
      // 非 iOS 平台或通知权限关闭时不影响记录本身。
    }
  }

  Future<void> startVoice() async {
    if (recording || recognizing) return;
    _voiceReady = false;
    _pressStartedAt = DateTime.now();
    setState(() {
      recording = true;
      error = null;
    });
    try {
      final future = voice.start();
      _voiceStart = future;
      await future;
      _voiceReady = true;
    } catch (e) {
      await voice.cancel();
      if (!mounted || _disposing) return;
      setState(() {
        recording = false;
        error = e.toString();
      });
    }
  }

  Future<void> stopVoice() async {
    if (!recording) return;
    setState(() {
      recording = false;
      recognizing = true;
    });
    var queued = false;
    try {
      await _voiceStart;
      if (!_voiceReady) return;
      final heldFor = DateTime.now().difference(
        _pressStartedAt ?? DateTime.now(),
      );
      if (heldFor < const Duration(milliseconds: 350)) {
        await voice.cancel();
        throw const ApiException('按住多说一会儿再松手哦');
      }
      final audio = await voice.stopRecording();
      if (!mounted || _disposing) return;
      final task = _PendingVoiceTask(id: _nextPendingId++, text: '刚刚的语音');
      task.status = '识别语音中';
      setState(() {
        pendingTasks.insert(0, task);
        recognizing = false;
      });
      queued = true;
      unawaited(_transcribeAndProcess(task, audio));
    } catch (e) {
      if (mounted && !_disposing) setState(() => error = e.toString());
    } finally {
      _voiceReady = false;
      _voiceStart = null;
      _pressStartedAt = null;
      if (!queued && mounted && !_disposing) {
        setState(() => recognizing = false);
      }
    }
  }

  Future<void> _transcribeAndProcess(
    _PendingVoiceTask task,
    List<int> audio,
  ) async {
    try {
      final text = await voice
          .transcribe(audio)
          .timeout(const Duration(seconds: 30));
      if (text.trim().isEmpty) throw const ApiException('没有识到内容');
      if (!mounted || _disposing) return;
      setState(() {
        task.text = text.trim();
        task.status = '分类排队中';
      });
      await _processPending(task);
    } catch (exception) {
      if (mounted && !_disposing) {
        final message = _voiceFailureMessage(exception, transcribing: true);
        setState(() {
          task.status = '识别失败';
          task.errorMessage = message;
          error = message;
        });
      }
    }
  }

  Future<void> _processPending(_PendingVoiceTask task) async {
    try {
      final result = await widget.api
          .ingest(
            task.text,
            onQueued: () {
              if (mounted && !_disposing) {
                setState(() => task.status = '信息处理中');
              }
            },
          )
          .timeout(const Duration(seconds: 40));
      await refresh();
      if (mounted && !_disposing) {
        setState(() => pendingTasks.removeWhere((item) => item.id == task.id));
        if (result['kind'] == 'save') {
          setState(() {
            tab = 4;
            _knowledgeRevision += 1;
          });
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('已存入个人知识库')));
        } else if (result['kind'] == 'ask') {
          final answer = result['answer'] as String?;
          if (answer != null && answer.isNotEmpty) {
            showDialog<void>(
              context: context,
              builder: (context) => AlertDialog(
                title: const Text('知识库回答'),
                content: Text(answer),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.pop(context),
                    child: const Text('知道了'),
                  ),
                ],
              ),
            );
          }
        }
      }
    } on TimeoutException {
      if (mounted && !_disposing) {
        setState(() => task.status = '后台处理中');
      }
      await Future<void>.delayed(const Duration(seconds: 15));
      await refresh();
      if (mounted && !_disposing) {
        setState(() => pendingTasks.removeWhere((item) => item.id == task.id));
      }
    } catch (exception) {
      if (mounted && !_disposing) {
        final message = _voiceFailureMessage(exception);
        setState(() {
          task.status = '处理失败';
          task.errorMessage = message;
          error = message;
        });
      }
    }
  }

  String _voiceFailureMessage(Object exception, {bool transcribing = false}) {
    if (exception is TimeoutException) {
      return transcribing ? '语音识别超时，请检查网络后重新录入' : '信息处理超时，请稍后刷新查看';
    }
    if (exception is ApiException) return exception.message;
    return transcribing ? '录音上传或语音识别失败，请重新录入' : '信息处理失败，请稍后重试';
  }

  void showHelp() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: const Color(0xfff5f4f0),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (context) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: .78,
        minChildSize: .5,
        maxChildSize: .94,
        builder: (context, scrollController) => ListView(
          controller: scrollController,
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 28),
          children: const [
            Center(
              child: SizedBox(
                width: 38,
                child: Divider(thickness: 4, color: Color(0xffcfcabf)),
              ),
            ),
            SizedBox(height: 8),
            Text(
              '使用帮助',
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800),
            ),
            SizedBox(height: 6),
            Text(
              '你只管自然地说，App 会判断你的意图并完成记录、提醒、保存或查询。',
              style: TextStyle(color: Color(0xff716b63), fontSize: 14),
            ),
            SizedBox(height: 22),
            _HelpItem(
              icon: Icons.cloud_done_outlined,
              title: '访客模式与登录',
              description:
                  '不登录也能使用语音记录、分类、提醒、知识库和报表，内容只保存在这台手机。登录后会把已有访客内容自动迁移到账号并保存到云端，换设备也能恢复。',
            ),
            _HelpItem(
              icon: Icons.mic_rounded,
              title: '怎么开始',
              description:
                  '按住底部橙色按钮开始说话，完整说完后再松开。松开后语音会自动转成文字并处理；处理中也可以继续录入下一条。',
            ),
            _HelpItem(
              icon: Icons.auto_awesome_rounded,
              title: '自动整理记录',
              description:
                  'App 会根据内容自动放进行程、账单、备忘或心愿，不需要你先选分类。例如：“明天下午去健身”会成为行程；“午饭花了 38 元”会成为账单；“想去冰岛看极光”会成为心愿。',
            ),
            _HelpItem(
              icon: Icons.alarm_rounded,
              title: '备忘会自动创建闹钟',
              description:
                  '说出要做的事和明确时间，例如“明早八点提醒我吃药”。App 会自动识别为备忘，并在 iPhone 上创建对应时间的系统闹钟；不支持闹钟的系统会改用带声音的通知。首次使用时请允许闹钟或通知权限。',
            ),
            _HelpItem(
              icon: Icons.lightbulb_outline_rounded,
              title: '保存到个人知识库',
              description:
                  '想长期保存方法、经验或资料时，可以说“保存到知识库：番茄炒蛋要先把鸡蛋炒熟盛出”。App 会整理标题和正文，之后可在“知识”页查看或删除。',
            ),
            _HelpItem(
              icon: Icons.question_answer_outlined,
              title: '直接提问，自动检索知识库',
              description:
                  '对着语音提出问题，App 会自动识别为提问，并从你的个人知识库中检索答案。例如：“番茄炒蛋怎么做来着？”或“我之前记的机场停车位置在哪里？”答案只依据你保存过的内容，不会把问题误存成普通记录。',
            ),
            _HelpItem(
              icon: Icons.calendar_month_outlined,
              title: '查看日期和报表',
              description:
                  '点顶部日期可选择某一天，左右箭头切换前后日期。点右上方趋势图标可查看所选日期的日报，以及所在月份的月报。',
            ),
            _HelpItem(
              icon: Icons.error_outline_rounded,
              title: '语音没有处理怎么办',
              description:
                  '每条语音下方会显示“识别语音中”“信息处理中”等状态。若失败，红色提示会说明具体原因；网络或识别失败时请重新录入，显示“后台处理中”时稍后下拉刷新即可。',
              isLast: true,
            ),
          ],
        ),
      ),
    );
  }

  void queueStopVoice() {
    Timer.run(() {
      if (mounted && !_disposing) stopVoice();
    });
  }

  Future<void> logout() async {
    await voice.dispose();
    await widget.api.logout();
    widget.onLogout();
  }

  Future<void> confirmDeleteAccount() async {
    if (deletingAccount) return;
    final understood = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除账户？'),
        content: const Text('你的全部记录、知识库、报表和云端账户数据将被永久删除，所有设备也会退出登录。此操作无法撤销。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('继续删除'),
          ),
        ],
      ),
    );
    if (understood != true || !mounted) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('最后确认'),
        content: const Text('确定永久删除账户及全部数据吗？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('保留账户'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            child: const Text('永久删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      deletingAccount = true;
      error = null;
    });
    try {
      await widget.api.deleteAccount();
      try {
        await reminders.sync(const []);
      } catch (_) {
        // The account is already deleted; reminder cleanup must not make the
        // user think the server operation failed.
      }
      if (mounted) widget.onLogout();
    } catch (exception) {
      if (mounted) {
        setState(() {
          deletingAccount = false;
          error = exception.toString();
        });
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(exception.toString())));
      }
    }
  }

  Future<void> confirmDeleteEntry(AssistantEntry entry) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除这条记录？'),
        content: Text(entry.description),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final previous = List<AssistantEntry>.of(entries);
    setState(() => entries.removeWhere((item) => item.id == entry.id));
    unawaited(_syncReminders(entries));
    try {
      await widget.api.deleteEntry(entry.id);
    } catch (e) {
      if (mounted) {
        setState(() {
          entries = previous;
          error = e.toString();
        });
      }
    }
  }

  Future<void> toggleEntryDone(AssistantEntry entry) async {
    if (!entry.done) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('标记为已完成？'),
          content: Text(entry.description),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('完成'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
    final previous = List<AssistantEntry>.of(entries);
    setState(() {
      entries = entries
          .map(
            (item) =>
                item.id == entry.id ? item.copyWith(done: !entry.done) : item,
          )
          .toList();
    });
    unawaited(_syncReminders(entries));
    try {
      final updated = await widget.api.toggleDone(entry.id, !entry.done);
      if (mounted) {
        setState(() {
          entries = entries
              .map((item) => item.id == updated.id ? updated : item)
              .toList();
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          entries = previous;
          error = e.toString();
        });
      }
    }
  }

  void moveDate(int days) {
    final next = DateUtils.dateOnly(selectedDate.add(Duration(days: days)));
    setState(() => selectedDate = next);
  }

  Future<void> pickDate() async {
    final value = await showDatePicker(
      context: context,
      initialDate: selectedDate,
      firstDate: DateTime(2020),
      lastDate: DateTime.now().add(const Duration(days: 730)),
      locale: const Locale('zh', 'CN'),
      builder: (context, child) => Theme(
        data: Theme.of(context).copyWith(
          colorScheme: const ColorScheme.light(
            primary: Color(0xffd97706),
            onPrimary: Colors.white,
            surface: Color(0xfff5f4f0),
            onSurface: Color(0xff1a1a1e),
          ),
        ),
        child: child!,
      ),
    );
    if (value != null && mounted) {
      setState(() => selectedDate = DateUtils.dateOnly(value));
    }
  }

  void openReport() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xfff5f4f0),
      builder: (context) => FractionallySizedBox(
        heightFactor: .9,
        child: ReportPane(
          api: widget.api,
          entries: entries,
          selectedDate: selectedDate,
        ),
      ),
    );
  }

  @override
  void dispose() {
    _disposing = true;
    voice.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final type = tabs[tab].$1;
    final isToday = DateUtils.isSameDay(selectedDate, DateTime.now());
    final selectedDayEntries = entries
        .where((entry) => DateUtils.isSameDay(entry.timestamp, selectedDate))
        .toList();
    final visible = entries
        .where(
          (entry) =>
              entry.type == type &&
              (type == EntryType.wish ||
                  DateUtils.isSameDay(entry.timestamp, selectedDate)),
        )
        .toList()
        .reversed
        .toList();
    // Keep the primary date line compact. Putting the year, month, day and
    // weekday on one line overflows between the navigation/action buttons on
    // narrow phones, so historical dates show the year in the secondary line.
    final dateLabel = DateFormat('M月d日 EEEE', 'zh_CN').format(selectedDate);
    final dateMeta = isToday
        ? '${selectedDayEntries.length} 条记录 · 今天'
        : '${selectedDate.year}年 · ${selectedDayEntries.length} 条记录';
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
              child: Row(
                children: [
                  IconButton(
                    onPressed: () => moveDate(-1),
                    tooltip: '前一天',
                    icon: const Icon(Icons.chevron_left_rounded, size: 26),
                  ),
                  Expanded(
                    child: InkWell(
                      onTap: pickDate,
                      borderRadius: BorderRadius.circular(12),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Text(
                                  dateLabel,
                                  style: const TextStyle(
                                    fontSize: 19,
                                    color: Color(0xff1a1a1e),
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                const SizedBox(width: 5),
                                const Icon(
                                  Icons.calendar_month_outlined,
                                  size: 16,
                                  color: Color(0xff8a8680),
                                ),
                              ],
                            ),
                            Text(
                              dateMeta,
                              style: const TextStyle(
                                fontSize: 11,
                                color: Color(0xff8a8680),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: () => moveDate(1),
                    tooltip: '后一天',
                    icon: Icon(
                      Icons.chevron_right_rounded,
                      size: 26,
                      color: const Color(0xff1a1a1e),
                    ),
                  ),
                  IconButton(
                    onPressed: openReport,
                    tooltip: '日报与月报',
                    icon: const Icon(Icons.insights_rounded, size: 21),
                  ),
                  PopupMenuButton<String>(
                    tooltip: '更多',
                    icon: const Icon(Icons.more_horiz_rounded, size: 22),
                    onSelected: (value) {
                      if (value == 'help') showHelp();
                      if (value == 'login') widget.onLogin();
                      if (value == 'logout') logout();
                      if (value == 'deleteAccount') confirmDeleteAccount();
                    },
                    itemBuilder: (_) => [
                      const PopupMenuItem(
                        value: 'help',
                        child: ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: Icon(Icons.help_outline_rounded),
                          title: Text('使用帮助'),
                        ),
                      ),
                      if (widget.isGuest)
                        const PopupMenuItem(
                          value: 'login',
                          child: ListTile(
                            contentPadding: EdgeInsets.zero,
                            leading: Icon(Icons.cloud_upload_outlined),
                            title: Text('登录并云端保存'),
                          ),
                        )
                      else ...const [
                        PopupMenuItem(
                          value: 'logout',
                          child: ListTile(
                            contentPadding: EdgeInsets.zero,
                            leading: Icon(Icons.logout_rounded),
                            title: Text('退出登录'),
                          ),
                        ),
                        PopupMenuDivider(),
                        PopupMenuItem(
                          value: 'deleteAccount',
                          child: ListTile(
                            contentPadding: EdgeInsets.zero,
                            leading: Icon(
                              Icons.delete_forever_outlined,
                              color: Colors.red,
                            ),
                            title: Text(
                              '删除账户',
                              style: TextStyle(color: Colors.red),
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
            SizedBox(
              height: 42,
              child: ListView.separated(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                scrollDirection: Axis.horizontal,
                itemCount: tabs.length,
                separatorBuilder: (_, _) => const SizedBox(width: 3),
                itemBuilder: (context, index) {
                  final selected = tab == index;
                  final itemType = tabs[index].$1;
                  final count = itemType == null
                      ? null
                      : entries
                            .where(
                              (entry) =>
                                  entry.type == itemType &&
                                  (itemType == EntryType.wish ||
                                      DateUtils.isSameDay(
                                        entry.timestamp,
                                        selectedDate,
                                      )),
                            )
                            .length;
                  return InkWell(
                    onTap: () => setState(() => tab = index),
                    borderRadius: BorderRadius.circular(999),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 160),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 8,
                      ),
                      decoration: BoxDecoration(
                        color: selected
                            ? const Color(0xffd97706)
                            : const Color(0xffede9e1),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            tabs[index].$3,
                            size: 13,
                            color: selected
                                ? Colors.white
                                : const Color(0xff716b63),
                          ),
                          const SizedBox(width: 4),
                          Text(
                            count == null
                                ? tabs[index].$2
                                : '${tabs[index].$2} $count',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: selected
                                  ? Colors.white
                                  : const Color(0xff5f5a53),
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                },
              ),
            ),
            if (widget.isGuest)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: const Color(0xffffead5),
                  borderRadius: BorderRadius.circular(11),
                ),
                child: Row(
                  children: [
                    const Icon(
                      Icons.person_outline_rounded,
                      size: 17,
                      color: Color(0xffb45f06),
                    ),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        '访客模式 · 数据保存在本机',
                        style: TextStyle(
                          color: Color(0xff8f4f0b),
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: widget.onLogin,
                      style: TextButton.styleFrom(
                        visualDensity: VisualDensity.compact,
                        foregroundColor: const Color(0xffb45f06),
                      ),
                      child: const Text('登录保存'),
                    ),
                  ],
                ),
              ),
            if (error != null)
              Container(
                margin: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xffffe4e4),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        error!,
                        style: const TextStyle(
                          color: Color(0xffb42318),
                          fontSize: 12,
                        ),
                      ),
                    ),
                    IconButton(
                      onPressed: () => setState(() => error = null),
                      icon: const Icon(Icons.close, size: 16),
                    ),
                  ],
                ),
              ),
            Expanded(
              child: tab == 4
                  ? KnowledgePane(
                      key: ValueKey(_knowledgeRevision),
                      api: widget.api,
                    )
                  : loading
                  ? const Center(child: CircularProgressIndicator())
                  : RefreshIndicator(
                      onRefresh: refresh,
                      child: visible.isEmpty
                          ? ListView(
                              children: const [
                                SizedBox(height: 160),
                                Center(
                                  child: Text(
                                    '还没有记录，按住下方按钮说一句',
                                    style: TextStyle(color: Color(0xff8a8680)),
                                  ),
                                ),
                              ],
                            )
                          : ListView.separated(
                              padding: const EdgeInsets.all(16),
                              itemCount: visible.length,
                              separatorBuilder: (_, _) =>
                                  const SizedBox(height: 9),
                              itemBuilder: (context, index) => EntryCard(
                                entry: visible[index],
                                reminderScheduled: scheduledReminderIds
                                    .contains(visible[index].id),
                                onToggleDone:
                                    visible[index].type == EntryType.memo
                                    ? () => toggleEntryDone(visible[index])
                                    : null,
                                onDelete: () =>
                                    confirmDeleteEntry(visible[index]),
                              ),
                            ),
                    ),
            ),
            if (pendingTasks.isNotEmpty)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
                padding: const EdgeInsets.fromLTRB(12, 8, 10, 8),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: const Color(0xffe5ded4)),
                ),
                child: Column(
                  children: [
                    for (final task in pendingTasks.take(3))
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Row(
                          children: [
                            const Icon(
                              Icons.graphic_eq_rounded,
                              size: 16,
                              color: Color(0xff8a8680),
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    task.text,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 13),
                                  ),
                                  if (task.errorMessage != null)
                                    Text(
                                      task.errorMessage!,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        color: Color(0xffb42318),
                                        fontSize: 10,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 4,
                              ),
                              decoration: BoxDecoration(
                                color: task.failed
                                    ? const Color(0xffffe4e4)
                                    : const Color(0xfffff0df),
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Text(
                                task.status,
                                style: TextStyle(
                                  color: task.failed
                                      ? const Color(0xffb42318)
                                      : const Color(0xffb45f06),
                                  fontSize: 10,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            if (task.failed)
                              IconButton(
                                tooltip: '移除',
                                visualDensity: VisualDensity.compact,
                                onPressed: () => setState(
                                  () => pendingTasks.removeWhere(
                                    (item) => item.id == task.id,
                                  ),
                                ),
                                icon: const Icon(Icons.close_rounded, size: 16),
                              ),
                          ],
                        ),
                      ),
                    if (pendingTasks.length > 3)
                      Align(
                        alignment: Alignment.centerRight,
                        child: Text(
                          '还有 ${pendingTasks.length - 3} 条等待处理',
                          style: const TextStyle(
                            color: Color(0xff8a8680),
                            fontSize: 10,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
              child: Column(
                children: [
                  Listener(
                    behavior: HitTestBehavior.opaque,
                    onPointerDown: (_) => startVoice(),
                    onPointerUp: (_) => queueStopVoice(),
                    onPointerCancel: (_) => queueStopVoice(),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 160),
                      width: 108,
                      height: 108,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: recognizing
                            ? const Color(0xffede9e1)
                            : recording
                            ? const Color(0xffffe2e2)
                            : const Color(0xffd97706),
                        boxShadow: recording || recognizing
                            ? const []
                            : [
                                BoxShadow(
                                  color: const Color(
                                    0xffd97706,
                                  ).withValues(alpha: .32),
                                  blurRadius: 22,
                                  offset: const Offset(0, 8),
                                ),
                              ],
                      ),
                      child: recognizing
                          ? const Padding(
                              padding: EdgeInsets.all(39),
                              child: CircularProgressIndicator(
                                color: Color(0xff8a8680),
                                strokeWidth: 2.5,
                              ),
                            )
                          : Icon(
                              recording
                                  ? Icons.graphic_eq_rounded
                                  : Icons.mic_rounded,
                              size: 42,
                              color: recording
                                  ? const Color(0xffdc2626)
                                  : Colors.white,
                            ),
                    ),
                  ),
                  const SizedBox(height: 9),
                  Text(
                    recording
                        ? '正在聆听 · 松开即记录'
                        : recognizing
                        ? '正在发送语音…'
                        : pendingTasks.isNotEmpty
                        ? '信息处理中 · 可继续按住录入下一条'
                        : '按住说话 · 松开直接记录',
                    style: const TextStyle(
                      color: Color(0xff9b968e),
                      fontSize: 11,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _HelpItem extends StatelessWidget {
  const _HelpItem({
    required this.icon,
    required this.title,
    required this.description,
    this.isLast = false,
  });

  final IconData icon;
  final String title;
  final String description;
  final bool isLast;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: isLast ? 0 : 20),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: const Color(0xffffead5),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, size: 21, color: const Color(0xffc56b09)),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    color: Color(0xff1a1a1e),
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  description,
                  style: const TextStyle(
                    color: Color(0xff716b63),
                    fontSize: 13,
                    height: 1.5,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class ReportPane extends StatefulWidget {
  const ReportPane({
    super.key,
    required this.api,
    required this.entries,
    required this.selectedDate,
  });

  final ApiClient api;
  final List<AssistantEntry> entries;
  final DateTime selectedDate;

  @override
  State<ReportPane> createState() => _ReportPaneState();
}

class _ReportPaneState extends State<ReportPane> {
  String scope = 'day';
  AssistantReport? report;
  bool loading = false;
  bool stale = false;
  DateTime? updatedAt;
  String? error;

  @override
  void initState() {
    super.initState();
    load();
  }

  DateTime get weekMonday => DateUtils.dateOnly(
    widget.selectedDate.subtract(
      Duration(days: widget.selectedDate.weekday - 1),
    ),
  );

  List<AssistantEntry> get relevant => widget.entries.where((entry) {
    if (scope == 'day') {
      return DateUtils.isSameDay(entry.timestamp, widget.selectedDate);
    }
    if (scope == 'week') {
      final date = DateUtils.dateOnly(entry.timestamp);
      return !date.isBefore(weekMonday) &&
          date.isBefore(weekMonday.add(const Duration(days: 7)));
    }
    return entry.timestamp.year == widget.selectedDate.year &&
        entry.timestamp.month == widget.selectedDate.month;
  }).toList();

  String get dateLabel {
    if (scope == 'day') {
      return DateFormat('yyyy年M月d日', 'zh_CN').format(widget.selectedDate);
    }
    if (scope == 'week') {
      final sunday = weekMonday.add(const Duration(days: 6));
      return '${DateFormat('M月d日', 'zh_CN').format(weekMonday)} 至 ${DateFormat('M月d日', 'zh_CN').format(sunday)}';
    }
    return DateFormat('yyyy年M月', 'zh_CN').format(widget.selectedDate);
  }

  String get periodKey => scope == 'day'
      ? DateFormat('yyyy-MM-dd').format(widget.selectedDate)
      : scope == 'week'
      ? DateFormat('yyyy-MM-dd').format(weekMonday)
      : DateFormat('yyyy-MM').format(widget.selectedDate);

  Future<void> load() async {
    setState(() {
      loading = relevant.isNotEmpty;
      report = null;
      stale = false;
      updatedAt = null;
      error = null;
    });
    if (relevant.isEmpty) return;
    try {
      final value = await widget.api.report(
        scope: scope,
        periodKey: periodKey,
        dateLabel: dateLabel,
        entries: relevant,
      );
      if (mounted && value != null) {
        setState(() {
          report = value.report;
          stale = value.stale;
          updatedAt = value.updatedAt;
          loading = false;
        });
        if (value.refreshJobId != null) {
          unawaited(_waitForRefresh(value.refreshJobId!));
        }
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _waitForRefresh(String jobId) async {
    try {
      final value = await widget.api.waitForReport(jobId);
      if (mounted) {
        setState(() {
          report = value;
          stale = false;
          updatedAt = DateTime.now();
        });
      }
    } catch (_) {
      // 继续展示旧报告；下次打开会再次检查内容版本。
    }
  }

  void changeScope(String value) {
    if (scope == value) return;
    setState(() => scope = value);
    load();
  }

  @override
  Widget build(BuildContext context) {
    final expense = relevant
        .where((entry) => entry.type == EntryType.expense)
        .fold<double>(0, (sum, entry) => sum + (entry.amount ?? 0));
    final memos = relevant
        .where((entry) => entry.type == EntryType.memo)
        .toList();
    final completed = memos.where((entry) => entry.done).length;
    return SafeArea(
      top: false,
      child: Column(
        children: [
          Container(
            width: 38,
            height: 4,
            margin: const EdgeInsets.only(top: 10, bottom: 12),
            decoration: BoxDecoration(
              color: const Color(0xffc8c2b9),
              borderRadius: BorderRadius.circular(99),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: Row(
              children: [
                const Expanded(
                  child: Text(
                    '生活报告',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800),
                  ),
                ),
                IconButton(
                  onPressed: () => Navigator.pop(context),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 6, 18, 14),
            child: SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'day', label: Text('日报')),
                ButtonSegment(value: 'week', label: Text('周报')),
                ButtonSegment(value: 'month', label: Text('月报')),
              ],
              selected: {scope},
              onSelectionChanged: (value) => changeScope(value.first),
              style: const ButtonStyle(visualDensity: VisualDensity.compact),
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(18, 0, 18, 28),
              children: [
                Text(
                  dateLabel,
                  style: const TextStyle(color: Color(0xff8a8680)),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    _StatCard(label: '记录', value: '${relevant.length} 条'),
                    const SizedBox(width: 8),
                    _StatCard(
                      label: '花费',
                      value: '¥${expense.toStringAsFixed(2)}',
                    ),
                    const SizedBox(width: 8),
                    _StatCard(label: '完成', value: '$completed/${memos.length}'),
                  ],
                ),
                const SizedBox(height: 18),
                if (report != null && (stale || updatedAt != null)) ...[
                  Container(
                    margin: const EdgeInsets.only(bottom: 12),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 9,
                    ),
                    decoration: BoxDecoration(
                      color: stale
                          ? const Color(0xfffff0df)
                          : const Color(0xffede9e1),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          stale ? Icons.sync_rounded : Icons.bolt_rounded,
                          size: 16,
                          color: stale
                              ? const Color(0xffb45f06)
                              : const Color(0xff716b63),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            stale ? '已有新记录，先展示上次报告，正在后台更新…' : '内容未变化，已直接读取缓存',
                            style: const TextStyle(
                              fontSize: 11,
                              color: Color(0xff716b63),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                if (relevant.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: 100),
                    child: Center(
                      child: Text(
                        '这个时间段还没有记录',
                        style: TextStyle(color: Color(0xff8a8680)),
                      ),
                    ),
                  )
                else if (loading)
                  const Padding(
                    padding: EdgeInsets.only(top: 70),
                    child: Column(
                      children: [
                        CircularProgressIndicator(),
                        SizedBox(height: 14),
                        Text(
                          '正在整理记录并生成报告…',
                          style: TextStyle(color: Color(0xff8a8680)),
                        ),
                      ],
                    ),
                  )
                else if (error != null)
                  _ReportSection(
                    title: '暂时没有生成分析',
                    icon: Icons.info_outline_rounded,
                    items: [error!],
                  )
                else if (report != null) ...[
                  _ReportSection(
                    title: '做得不错',
                    icon: Icons.thumb_up_alt_outlined,
                    items: report!.highlights,
                  ),
                  _ReportSection(
                    title: '可以留意',
                    icon: Icons.visibility_outlined,
                    items: report!.improvements,
                  ),
                  _ReportSection(
                    title: scope == 'day'
                        ? '明天建议'
                        : scope == 'week'
                        ? '下周建议'
                        : '下月建议',
                    icon: Icons.lightbulb_outline_rounded,
                    items: report!.suggestions,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Expanded(
    child: Container(
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        children: [
          Text(value, style: const TextStyle(fontWeight: FontWeight.w800)),
          const SizedBox(height: 3),
          Text(
            label,
            style: const TextStyle(fontSize: 11, color: Color(0xff8a8680)),
          ),
        ],
      ),
    ),
  );
}

class _ReportSection extends StatelessWidget {
  const _ReportSection({
    required this.title,
    required this.icon,
    required this.items,
  });
  final String title;
  final IconData icon;
  final List<String> items;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(15),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: const Color(0xffd97706)),
              const SizedBox(width: 8),
              Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
            ],
          ),
          const SizedBox(height: 10),
          for (final item in items)
            Padding(
              padding: const EdgeInsets.only(bottom: 7),
              child: Text('• $item', style: const TextStyle(height: 1.45)),
            ),
        ],
      ),
    );
  }
}

class KnowledgePane extends StatefulWidget {
  const KnowledgePane({super.key, required this.api});

  final ApiClient api;

  @override
  State<KnowledgePane> createState() => _KnowledgePaneState();
}

class _KnowledgePaneState extends State<KnowledgePane> {
  List<KnowledgeItem> items = [];
  bool loading = true;
  String? error;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final value = await widget.api.knowledge();
      if (mounted) {
        setState(() {
          items = value;
          error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> remove(KnowledgeItem item) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除这条知识？'),
        content: Text(item.title),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final previous = List<KnowledgeItem>.of(items);
    setState(() => items.removeWhere((value) => value.id == item.id));
    try {
      await widget.api.deleteKnowledge(item.id);
    } catch (e) {
      if (mounted) {
        setState(() {
          items = previous;
          error = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return loading
        ? const Center(child: CircularProgressIndicator())
        : RefreshIndicator(
            onRefresh: load,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (error != null)
                  Container(
                    margin: const EdgeInsets.only(bottom: 12),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xffffe4e4),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Text(
                      error!,
                      style: const TextStyle(color: Color(0xffb42318)),
                    ),
                  ),
                if (items.isEmpty)
                  const Padding(
                    padding: EdgeInsets.only(top: 150),
                    child: Column(
                      children: [
                        Icon(
                          Icons.lightbulb_outline_rounded,
                          size: 42,
                          color: Color(0xffc1bbb2),
                        ),
                        SizedBox(height: 14),
                        Text(
                          '还没有知识',
                          style: TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        SizedBox(height: 8),
                        Text(
                          '按住麦克风说“记到知识库：……”\n以后可以直接用语音询问',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Color(0xff8a8680)),
                        ),
                      ],
                    ),
                  )
                else
                  for (final item in items)
                    Container(
                      margin: const EdgeInsets.only(bottom: 10),
                      padding: const EdgeInsets.fromLTRB(16, 14, 8, 14),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(15),
                        border: Border.all(
                          color: Colors.black.withValues(alpha: .06),
                        ),
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(
                            Icons.lightbulb_rounded,
                            color: Color(0xffd97706),
                            size: 20,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  item.title,
                                  style: const TextStyle(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                                const SizedBox(height: 5),
                                Text(
                                  item.content,
                                  style: const TextStyle(
                                    color: Color(0xff716b63),
                                    height: 1.45,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          IconButton(
                            onPressed: () => remove(item),
                            tooltip: '删除知识',
                            icon: const Icon(
                              Icons.delete_outline_rounded,
                              size: 19,
                              color: Color(0xffaaa59c),
                            ),
                          ),
                        ],
                      ),
                    ),
              ],
            ),
          );
  }
}

class EntryCard extends StatelessWidget {
  const EntryCard({
    super.key,
    required this.entry,
    required this.onDelete,
    this.reminderScheduled = false,
    this.onToggleDone,
  });
  final AssistantEntry entry;
  final VoidCallback onDelete;
  final bool reminderScheduled;
  final VoidCallback? onToggleDone;

  @override
  Widget build(BuildContext context) {
    final amount = entry.amount == null
        ? null
        : '¥${entry.amount!.toStringAsFixed(2)}';
    final reminderExpired = entry.reminderAt?.isBefore(DateTime.now()) ?? false;
    final reminderColor = reminderExpired
        ? const Color(0xff8a8680)
        : reminderScheduled
        ? const Color(0xff16a34a)
        : const Color(0xffdc2626);
    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(15),
        border: Border.all(color: Colors.black.withValues(alpha: .06)),
      ),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: const Color(0xfff2eee7),
              borderRadius: BorderRadius.circular(11),
            ),
            child: const Icon(
              Icons.auto_awesome_rounded,
              size: 18,
              color: Color(0xffd97706),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  entry.description,
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: entry.done
                        ? const Color(0xff8a8680)
                        : const Color(0xff1a1a1e),
                    decoration: entry.done
                        ? TextDecoration.lineThrough
                        : TextDecoration.none,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  [
                    entry.category,
                    if (entry.time.isNotEmpty) entry.time,
                  ].join('  '),
                  style: const TextStyle(
                    fontSize: 11,
                    color: Color(0xff8a8680),
                  ),
                ),
                if (entry.hasTimeRange) ...[
                  const SizedBox(height: 4),
                  Text(
                    '${entry.timeStart} → ${entry.timeEnd}',
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: Color(0xffd97706),
                    ),
                  ),
                ],
                if (entry.reminderAt != null) ...[
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Icon(
                        reminderScheduled
                            ? Icons.alarm_on_rounded
                            : Icons.alarm_off_rounded,
                        size: 13,
                        color: reminderColor,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        reminderExpired
                            ? '${DateFormat('M月d日 HH:mm', 'zh_CN').format(entry.reminderAt!)} · 时间已过'
                            : reminderScheduled
                            ? '${DateFormat('M月d日 HH:mm', 'zh_CN').format(entry.reminderAt!)} · 系统闹钟已安排'
                            : '${DateFormat('M月d日 HH:mm', 'zh_CN').format(entry.reminderAt!)} · 闹钟未创建',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: reminderColor,
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (amount != null)
                Text(
                  amount,
                  style: const TextStyle(
                    fontWeight: FontWeight.w700,
                    color: Color(0xffd97706),
                  ),
                ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (onToggleDone != null)
                    IconButton(
                      onPressed: onToggleDone,
                      tooltip: entry.done ? '取消完成' : '标记完成',
                      constraints: const BoxConstraints.tightFor(
                        width: 32,
                        height: 32,
                      ),
                      padding: EdgeInsets.zero,
                      icon: Icon(
                        entry.done
                            ? Icons.check_circle_rounded
                            : Icons.check_circle_outline_rounded,
                        size: 19,
                        color: entry.done
                            ? const Color(0xff16a34a)
                            : const Color(0xffaaa59c),
                      ),
                    ),
                  IconButton(
                    onPressed: onDelete,
                    tooltip: '删除记录',
                    constraints: const BoxConstraints.tightFor(
                      width: 32,
                      height: 32,
                    ),
                    padding: EdgeInsets.zero,
                    icon: const Icon(
                      Icons.delete_outline_rounded,
                      size: 19,
                      color: Color(0xffaaa59c),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}
