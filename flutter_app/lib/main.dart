import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter/services.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api_client.dart';
import 'document_audio_player.dart';
import 'models.dart';
import 'persistent_meeting_recorder.dart';
import 'reminder_service.dart';
import 'qq_group_center_page.dart';
import 'voice_service.dart';
import 'world_pulse_page.dart';

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
    if (busy) return;
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
                                  onChanged: (value) {
                                    if (value.trim().length == 6 && !busy) {
                                      submit();
                                    }
                                  },
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

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  static const shortcutChannel = MethodChannel(
    'com.from2033.assistant/shortcuts',
  );
  late final VoiceService voice = VoiceService(widget.api);
  late final PersistentMeetingRecorder meetingRecorder =
      PersistentMeetingRecorder(widget.api);
  final ReminderService reminders = ReminderService();
  List<AssistantEntry> entries = [];
  int tab = 0;
  bool loading = true;
  bool recording = false;
  bool recognizing = false;
  String? error;
  Set<String> scheduledReminderIds = {};
  String reminderSyncMode = 'none';
  final List<_PendingVoiceTask> pendingTasks = [];
  int _nextPendingId = 1;
  int _knowledgeRevision = 0;
  int _startMeetingRecordingRequest = 0;
  bool showCompletedTodos = false;
  DateTime selectedDate = DateUtils.dateOnly(DateTime.now());
  Future<void>? _voiceStart;
  DateTime? _pressStartedAt;
  bool _voiceReady = false;
  bool _disposing = false;
  bool _recoveringMeetingRecordings = false;
  Map<String, dynamic>? worldPulse;
  bool worldPulseLoading = false;
  String? worldPulseError;
  Timer? worldPulseAnalysisTimer;

  static const List<(String, IconData)> tabs = [
    ('首页', Icons.mic_none_rounded),
    ('待办', Icons.checklist_rounded),
    ('资料库', Icons.folder_copy_outlined),
    ('我的', Icons.person_outline_rounded),
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    shortcutChannel.setMethodCallHandler(_handleShortcutMethod);
    refresh();
    unawaited(refreshWorldPulse());
    if (!widget.isGuest) unawaited(_recoverMeetingRecordings());
    unawaited(_consumePendingShortcut());
  }

  Future<dynamic> _handleShortcutMethod(MethodCall call) async {
    if (call.method != 'startRecording') return;
    await shortcutChannel.invokeMethod<bool>('consumeStartRecording');
    _requestMeetingRecording();
  }

  Future<void> _consumePendingShortcut() async {
    try {
      final pending =
          await shortcutChannel.invokeMethod<bool>('consumeStartRecording') ??
          false;
      if (pending) _requestMeetingRecording();
    } on MissingPluginException {
      // Android、Web 等平台没有 iOS 快捷指令通道。
    }
  }

  void _requestMeetingRecording() {
    if (!mounted) return;
    setState(() {
      tab = 2;
      _startMeetingRecordingRequest += 1;
    });
  }

  Future<void> refreshWorldPulse({bool force = false}) async {
    if (worldPulseLoading) return;
    if (mounted) {
      setState(() {
        worldPulseLoading = true;
        worldPulseError = null;
      });
    }
    try {
      final value = await widget.api.worldPulse(force: force);
      if (mounted) {
        setState(() => worldPulse = value);
        worldPulseAnalysisTimer?.cancel();
        if (value['analysisStatus'] == 'PROCESSING') {
          worldPulseAnalysisTimer = Timer(
            const Duration(seconds: 5),
            refreshWorldPulse,
          );
        }
      }
    } catch (exception) {
      if (mounted) setState(() => worldPulseError = exception.toString());
    } finally {
      if (mounted) setState(() => worldPulseLoading = false);
    }
  }

  Future<void> refreshHome() async {
    await Future.wait([refresh(), refreshWorldPulse(force: true)]);
  }

  Future<void> _recoverMeetingRecordings() async {
    if (_recoveringMeetingRecordings || meetingRecorder.isRecording) return;
    _recoveringMeetingRecordings = true;
    await meetingRecorder.beginProcessing();
    try {
      final recovered = await meetingRecorder.recoverPending();
      for (final result in recovered) {
        final timestamp = DateFormat(
          'yyyyMMdd-HHmmss',
        ).format(result.createdAt);
        await widget.api.uploadDocument(
          fileName: '会议录音-$timestamp.wav',
          mimeType: 'audio/wav',
          bytes: result.wav,
          note: result.transcript.isEmpty
              ? '会议/谈话录音。App 意外结束后已恢复原始录音。'
              : '会议/谈话录音恢复转写：\n${result.transcript}',
          waitForProcessing: false,
        );
        await meetingRecorder.markUploaded(result.sessionId);
      }
      if (mounted && recovered.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('已恢复并归档 ${recovered.length} 段意外中断的录音')),
        );
      }
    } catch (_) {
      if (mounted) {
        setState(() => error = '有录音安全保存在本机，进入资料库可重新上传');
      }
    } finally {
      await meetingRecorder.endProcessing();
      _recoveringMeetingRecordings = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_consumePendingShortcut());
    }
    if (state == AppLifecycleState.resumed && !widget.isGuest) {
      unawaited(_recoverMeetingRecordings());
    }
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
          reminderSyncMode = result.mode;
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
    var backgroundProcessing = false;
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
      await voice.beginProcessing();
      backgroundProcessing = true;
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
      // 后台任务的所有权交给异步上传流程，避免 stopVoice 的 finally 提前释放。
      backgroundProcessing = false;
    } catch (e) {
      if (mounted && !_disposing) setState(() => error = e.toString());
    } finally {
      if (backgroundProcessing) await voice.endProcessing();
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
    var backgroundProcessing = true;
    Future<void> finishBackgroundProcessing() async {
      if (!backgroundProcessing) return;
      backgroundProcessing = false;
      await voice.endProcessing();
    }

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
      await _processPending(
        task,
        onQueued: () => unawaited(finishBackgroundProcessing()),
      );
    } catch (exception) {
      if (mounted && !_disposing) {
        final message = _voiceFailureMessage(exception, transcribing: true);
        setState(() {
          task.status = '识别失败';
          task.errorMessage = message;
          error = message;
        });
      }
    } finally {
      await finishBackgroundProcessing();
    }
  }

  Future<void> _processPending(
    _PendingVoiceTask task, {
    void Function()? onQueued,
  }) async {
    try {
      final result = await widget.api
          .ingest(
            task.text,
            onQueued: () {
              if (mounted && !_disposing) {
                setState(() => task.status = '信息处理中');
              }
              onQueued?.call();
            },
          )
          // ApiClient 自己会持续轮询任务；这里留足本地模型失败后回退云端的时间。
          .timeout(const Duration(seconds: 95));
      await refresh();
      if (mounted && !_disposing) {
        setState(() => pendingTasks.removeWhere((item) => item.id == task.id));
        if (result['kind'] == 'save') {
          setState(() {
            tab = 2;
            _knowledgeRevision += 1;
          });
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('已存入个人知识库')));
        } else if (result['kind'] == 'research') {
          setState(() => _knowledgeRevision += 1);
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('已开始后台研究，完成后可在资料库查看')));
        } else if (result['kind'] == 'ask') {
          final answer = result['answer'] as String?;
          if (answer != null && answer.isNotEmpty) {
            final sources = (result['sources'] as List<dynamic>? ?? const [])
                .whereType<Map>()
                .map((source) => Map<String, dynamic>.from(source))
                .toList();
            showDialog<void>(
              context: context,
              builder: (context) =>
                  _KnowledgeAnswerDialog(answer: answer, sources: sources),
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

  Future<void> confirmDeleteEntry(AssistantEntry entry) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除这条记录？'),
        content: Text(entry.displayDescription),
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
          content: Text(entry.displayDescription),
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

  @override
  void dispose() {
    _disposing = true;
    WidgetsBinding.instance.removeObserver(this);
    shortcutChannel.setMethodCallHandler(null);
    worldPulseAnalysisTimer?.cancel();
    voice.dispose();
    meetingRecorder.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            _buildPageHeader(),
            if (widget.isGuest) _buildGuestBanner(),
            if (error != null) _buildErrorBanner(),
            Expanded(child: _buildCurrentPage()),
            if (tab == 0) _buildPendingTasks(),
            if (tab == 0) _buildVoiceInput(),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (index) => setState(() => tab = index),
        backgroundColor: const Color(0xfffbfaf7),
        indicatorColor: const Color(0xffffdfb8),
        destinations: [
          for (final item in tabs)
            NavigationDestination(icon: Icon(item.$2), label: item.$1),
        ],
      ),
    );
  }

  Widget _buildPageHeader() {
    const titles = ['今天', '待办', '资料库', '我的'];
    const subtitles = ['说一句，我来记录和查询', '把没做完的事情理清楚', '长期保存的资料与知识', '心愿与账号'];
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 12, 10),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  titles[tab],
                  style: const TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.w800,
                    color: Color(0xff1a1a1e),
                  ),
                ),
                Text(
                  subtitles[tab],
                  style: const TextStyle(
                    fontSize: 11,
                    color: Color(0xff8a8680),
                  ),
                ),
              ],
            ),
          ),
          if (tab == 0)
            IconButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) =>
                      WorldPulsePage(api: widget.api, initialData: worldPulse),
                ),
              ),
              tooltip: '世界趋势与中国政策',
              icon: const Icon(Icons.public_rounded),
            ),
          IconButton(
            onPressed: tab == 0 ? refreshHome : refresh,
            tooltip: '刷新',
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
    );
  }

  Widget _buildCurrentPage() {
    if (loading) return const Center(child: CircularProgressIndicator());
    return switch (tab) {
      0 => _buildHomePage(),
      1 => _buildReminderPage(),
      2 => _buildLibraryPage(),
      _ => _buildProfilePage(),
    };
  }

  String _dateKey(DateTime value) => DateFormat('yyyy-MM-dd').format(value);

  String? _scheduledDateOf(AssistantEntry entry) {
    if (entry.scheduledDate != null) return entry.scheduledDate;
    if (entry.reminderAt != null) return _dateKey(entry.reminderAt!);
    // 兼容旧版：“只说日期、没说时间”的事项以当天中午存储。
    if (entry.type == EntryType.memo &&
        entry.timestamp.hour == 12 &&
        entry.timestamp.minute == 0 &&
        entry.timestamp.second == 0) {
      return _dateKey(entry.timestamp);
    }
    if (entry.type == EntryType.activity &&
        (entry.hasTimeRange || entry.timestamp.isAfter(DateTime.now()))) {
      return _dateKey(entry.timestamp);
    }
    return null;
  }

  bool _activityStillRelevant(AssistantEntry entry, DateTime date) {
    final today = DateUtils.dateOnly(DateTime.now());
    final target = DateUtils.dateOnly(date);
    if (target.isAfter(today)) return true;
    if (target.isBefore(today)) return false;
    if (entry.timeEnd != null) {
      final parts = entry.timeEnd!.split(':');
      if (parts.length == 2) {
        final end = DateTime(
          today.year,
          today.month,
          today.day,
          int.tryParse(parts[0]) ?? 0,
          int.tryParse(parts[1]) ?? 0,
        );
        return end.isAfter(DateTime.now());
      }
    }
    // 只有日期、没有时刻的计划，当天全天保留。
    if (entry.scheduledDate != null && !entry.hasTimeRange) return true;
    return entry.timestamp.isAfter(DateTime.now());
  }

  Widget _buildHomePage() {
    final selectedKey = _dateKey(selectedDate);
    final dayActions =
        entries.where((entry) {
          final scheduledDate = _scheduledDateOf(entry);
          if (scheduledDate != selectedKey) return false;
          if (entry.type == EntryType.memo) return !entry.done;
          return entry.type == EntryType.activity &&
              _activityStillRelevant(entry, selectedDate);
        }).toList()..sort((a, b) {
          final aTime = a.reminderAt ?? a.timestamp;
          final bTime = b.reminderAt ?? b.timestamp;
          return aTime.compareTo(bTime);
        });
    final isToday = DateUtils.isSameDay(selectedDate, DateTime.now());
    return RefreshIndicator(
      onRefresh: refreshHome,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
        children: [
          _buildDateNavigator(dayActions.length),
          Padding(
            padding: const EdgeInsets.only(top: 18, bottom: 8),
            child: Text(
              isToday ? '今天要做' : '当天要做',
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
            ),
          ),
          if (dayActions.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: Center(
                child: Text(
                  '当天没有安排要做的事',
                  style: TextStyle(color: Color(0xff8a8680)),
                ),
              ),
            )
          else
            for (final entry in dayActions) ...[
              EntryCard(
                entry: entry,
                reminderScheduled: scheduledReminderIds.contains(entry.id),
                onToggleDone: entry.type == EntryType.memo
                    ? () => toggleEntryDone(entry)
                    : null,
                onDelete: () => confirmDeleteEntry(entry),
              ),
              const SizedBox(height: 9),
            ],
        ],
      ),
    );
  }

  Widget _buildDateNavigator(int count) {
    final isToday = DateUtils.isSameDay(selectedDate, DateTime.now());
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          IconButton(
            onPressed: () => moveDate(-1),
            icon: const Icon(Icons.chevron_left_rounded),
          ),
          Expanded(
            child: InkWell(
              onTap: pickDate,
              child: Column(
                children: [
                  Text(
                    DateFormat('M月d日 EEEE', 'zh_CN').format(selectedDate),
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  Text(
                    isToday
                        ? '$count 项要做 · 今天'
                        : '${selectedDate.year}年 · $count 项要做',
                    style: const TextStyle(
                      fontSize: 10,
                      color: Color(0xff8a8680),
                    ),
                  ),
                ],
              ),
            ),
          ),
          IconButton(
            onPressed: () => moveDate(1),
            icon: const Icon(Icons.chevron_right_rounded),
          ),
        ],
      ),
    );
  }

  List<Widget> _todoSection(
    String title,
    List<AssistantEntry> values, {
    Color? titleColor,
    String? description,
  }) {
    if (values.isEmpty) return const [];
    return [
      Padding(
        padding: const EdgeInsets.only(top: 18, bottom: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '$title  ${values.length}',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w800,
                color: titleColor,
              ),
            ),
            if (description != null) ...[
              const SizedBox(height: 3),
              Text(
                description,
                style: const TextStyle(fontSize: 11, color: Color(0xff8a8680)),
              ),
            ],
          ],
        ),
      ),
      for (final entry in values) ...[
        EntryCard(
          entry: entry,
          reminderScheduled: scheduledReminderIds.contains(entry.id),
          onToggleDone: () => toggleEntryDone(entry),
          onDelete: () => confirmDeleteEntry(entry),
        ),
        const SizedBox(height: 9),
      ],
    ];
  }

  Widget _buildReminderPage() {
    final todayKey = _dateKey(DateTime.now());
    final active = entries
        .where((entry) => entry.isTodoItem && !entry.done)
        .toList();
    final overdue =
        active.where((entry) {
          final date = _scheduledDateOf(entry);
          return date != null && date.compareTo(todayKey) < 0;
        }).toList()..sort(
          (a, b) =>
              (_scheduledDateOf(a) ?? '').compareTo(_scheduledDateOf(b) ?? ''),
        );
    final today =
        active.where((entry) => _scheduledDateOf(entry) == todayKey).toList()
          ..sort(
            (a, b) => (a.reminderAt ?? a.timestamp).compareTo(
              b.reminderAt ?? b.timestamp,
            ),
          );
    final upcoming =
        active.where((entry) {
          final date = _scheduledDateOf(entry);
          return date != null && date.compareTo(todayKey) > 0;
        }).toList()..sort(
          (a, b) => (a.reminderAt ?? a.timestamp).compareTo(
            b.reminderAt ?? b.timestamp,
          ),
        );
    final undated =
        active.where((entry) => _scheduledDateOf(entry) == null).toList()
          ..sort((a, b) => b.timestamp.compareTo(a.timestamp));
    final completed =
        entries.where((entry) => entry.isTodoItem && entry.done).toList()
          ..sort((a, b) => b.timestamp.compareTo(a.timestamp));
    final scheduled = active
        .where((entry) => scheduledReminderIds.contains(entry.id))
        .length;
    final hasActive = active.isNotEmpty;

    return RefreshIndicator(
      onRefresh: refresh,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 18),
        children: [
          if (scheduled > 0 || reminderSyncMode == 'denied')
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 10),
              decoration: BoxDecoration(
                color: const Color(0xffffead5),
                borderRadius: BorderRadius.circular(13),
              ),
              child: Row(
                children: [
                  Icon(
                    reminderSyncMode == 'denied'
                        ? Icons.notifications_off_outlined
                        : Icons.alarm_on_rounded,
                    size: 18,
                    color: const Color(0xffb45f06),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      reminderSyncMode == 'denied'
                          ? '系统提醒权限未开启'
                          : '$scheduled 个系统提醒已安排',
                      style: const TextStyle(
                        color: Color(0xff8f4f0b),
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (!hasActive)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 70),
              child: Center(
                child: Text(
                  '没有未完成的待办',
                  style: TextStyle(color: Color(0xff8a8680)),
                ),
              ),
            ),
          ..._todoSection(
            '已过期',
            overdue,
            titleColor: const Color(0xffb42318),
            description: '日期已经过去，但还没有完成',
          ),
          ..._todoSection('今天', today),
          ..._todoSection('即将到来', upcoming),
          ..._todoSection('没有日期', undated, description: '会一直保留，直到完成或删除'),
          if (completed.isNotEmpty) ...[
            const SizedBox(height: 8),
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(
                '已完成  ${completed.length}',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              trailing: Icon(
                showCompletedTodos
                    ? Icons.expand_less_rounded
                    : Icons.expand_more_rounded,
              ),
              onTap: () =>
                  setState(() => showCompletedTodos = !showCompletedTodos),
            ),
            if (showCompletedTodos)
              for (final entry in completed.take(20)) ...[
                EntryCard(
                  entry: entry,
                  reminderScheduled: false,
                  onToggleDone: () => toggleEntryDone(entry),
                  onDelete: () => confirmDeleteEntry(entry),
                ),
                const SizedBox(height: 9),
              ],
          ],
        ],
      ),
    );
  }

  Widget _buildLibraryPage() {
    return KnowledgePane(
      key: ValueKey(_knowledgeRevision),
      api: widget.api,
      meetingRecorder: meetingRecorder,
      startRecordingRequest: _startMeetingRecordingRequest,
      onStartRecordingRequestHandled: () {
        if (mounted && _startMeetingRecordingRequest != 0) {
          setState(() => _startMeetingRecordingRequest = 0);
        }
      },
    );
  }

  void showWishList() {
    final wishes =
        entries.where((entry) => entry.type == EntryType.wish).toList()
          ..sort((a, b) => b.timestamp.compareTo(a.timestamp));
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: FractionallySizedBox(
          heightFactor: .82,
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 10, 10),
                child: Row(
                  children: [
                    const Icon(
                      Icons.star_outline_rounded,
                      color: Color(0xffb45f06),
                    ),
                    const SizedBox(width: 9),
                    const Expanded(
                      child: Text(
                        '愿望清单',
                        style: TextStyle(
                          fontSize: 21,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    IconButton(
                      onPressed: () => Navigator.pop(sheetContext),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: wishes.isEmpty
                    ? const Center(
                        child: Text(
                          '还没有心愿，可以直接用语音记下',
                          style: TextStyle(color: Color(0xff8a8680)),
                        ),
                      )
                    : ListView.separated(
                        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                        itemCount: wishes.length,
                        separatorBuilder: (_, _) => const SizedBox(height: 9),
                        itemBuilder: (_, index) => EntryCard(
                          entry: wishes[index],
                          reminderScheduled: false,
                          onDelete: () {
                            Navigator.pop(sheetContext);
                            unawaited(confirmDeleteEntry(wishes[index]));
                          },
                        ),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildProfilePage() {
    final wishCount = entries
        .where((entry) => entry.type == EntryType.wish)
        .length;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
      children: [
        _settingsTile(
          Icons.forum_outlined,
          'QQ群消息',
          '查看各群今日消息，汇总资料并打印',
          openStudyCenter,
        ),
        _settingsTile(
          Icons.star_outline_rounded,
          '愿望清单',
          wishCount == 0 ? '还没有记录心愿' : '$wishCount 个心愿',
          showWishList,
        ),
        if (widget.isGuest)
          _settingsTile(
            Icons.cloud_upload_outlined,
            '登录并云端保存',
            '登录后可换设备恢复数据',
            widget.onLogin,
          ),
        if (!widget.isGuest)
          _settingsTile(Icons.logout_rounded, '退出登录', '仅在你明确需要切换账号时使用', logout),
      ],
    );
  }

  Future<void> openStudyCenter() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => QqGroupCenterPage(api: widget.api),
      ),
    );
  }

  Widget _settingsTile(
    IconData icon,
    String title,
    String subtitle,
    VoidCallback? onTap,
  ) {
    return Card(
      elevation: 0,
      color: Colors.white,
      margin: const EdgeInsets.only(bottom: 10),
      child: ListTile(
        onTap: onTap,
        leading: Icon(icon, color: const Color(0xffb45f06)),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(subtitle),
        trailing: onTap == null
            ? null
            : const Icon(Icons.chevron_right_rounded),
      ),
    );
  }

  Widget _buildGuestBanner() => Container(
    width: double.infinity,
    margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
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
        TextButton(onPressed: widget.onLogin, child: const Text('登录保存')),
      ],
    ),
  );

  Widget _buildErrorBanner() => Container(
    margin: const EdgeInsets.fromLTRB(16, 2, 16, 8),
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
            style: const TextStyle(color: Color(0xffb42318), fontSize: 12),
          ),
        ),
        IconButton(
          onPressed: () => setState(() => error = null),
          icon: const Icon(Icons.close, size: 16),
        ),
      ],
    ),
  );

  Widget _buildPendingTasks() {
    if (pendingTasks.isEmpty) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xffe5ded4)),
      ),
      child: Column(
        children: [
          for (final task in pendingTasks.take(3))
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.graphic_eq_rounded, size: 18),
              title: Text(
                task.text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Text(
                task.errorMessage ?? task.status,
                style: TextStyle(
                  color: task.failed
                      ? const Color(0xffb42318)
                      : const Color(0xffb45f06),
                ),
              ),
              trailing: task.failed
                  ? IconButton(
                      onPressed: () =>
                          setState(() => pendingTasks.remove(task)),
                      icon: const Icon(Icons.close_rounded),
                    )
                  : null,
            ),
        ],
      ),
    );
  }

  Widget _buildVoiceInput() => Padding(
    padding: const EdgeInsets.fromLTRB(24, 6, 24, 12),
    child: Column(
      children: [
        Listener(
          behavior: HitTestBehavior.opaque,
          onPointerDown: (_) => startVoice(),
          onPointerUp: (_) => queueStopVoice(),
          onPointerCancel: (_) => queueStopVoice(),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            width: 92,
            height: 92,
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
                        color: const Color(0xffd97706).withValues(alpha: .32),
                        blurRadius: 20,
                        offset: const Offset(0, 7),
                      ),
                    ],
            ),
            child: recognizing
                ? const Padding(
                    padding: EdgeInsets.all(34),
                    child: CircularProgressIndicator(
                      color: Color(0xff8a8680),
                      strokeWidth: 2.5,
                    ),
                  )
                : Icon(
                    recording ? Icons.graphic_eq_rounded : Icons.mic_rounded,
                    size: 38,
                    color: recording ? const Color(0xffdc2626) : Colors.white,
                  ),
          ),
        ),
        const SizedBox(height: 7),
        Text(
          recording
              ? '正在聆听 · 松开即记录'
              : recognizing
              ? '正在发送语音…'
              : pendingTasks.isNotEmpty
              ? '信息处理中 · 可继续录入'
              : '按住说话 · 可以记录，也可以直接问',
          style: const TextStyle(color: Color(0xff9b968e), fontSize: 11),
        ),
      ],
    ),
  );
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
  const KnowledgePane({
    super.key,
    required this.api,
    required this.meetingRecorder,
    required this.startRecordingRequest,
    required this.onStartRecordingRequestHandled,
  });

  final ApiClient api;
  final PersistentMeetingRecorder meetingRecorder;
  final int startRecordingRequest;
  final VoidCallback onStartRecordingRequestHandled;

  @override
  State<KnowledgePane> createState() => _KnowledgePaneState();
}

class _KnowledgePaneState extends State<KnowledgePane> {
  List<KnowledgeItem> items = [];
  List<Map<String, dynamic>> documents = [];
  bool loading = true;
  bool uploading = false;
  bool meetingRecording = false;
  bool meetingSaving = false;
  bool retryingRecordings = false;
  int pendingRecordingCount = 0;
  int meetingProcessedChunks = 0;
  DateTime? meetingStartedAt;
  Duration meetingElapsed = Duration.zero;
  Timer? meetingTimer;
  Timer? documentRefreshTimer;
  bool hasLoadedDocuments = false;
  String? error;
  String documentCategory = '全部';
  static const documentChannel = MethodChannel(
    'com.from2033.assistant/documents',
  );

  @override
  void initState() {
    super.initState();
    meetingRecording = widget.meetingRecorder.isRecording;
    meetingStartedAt = widget.meetingRecorder.startedAt;
    if (meetingRecording) {
      _startMeetingTimer();
    }
    load();
    if (widget.startRecordingRequest > 0) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _handleStartRecordingRequest();
      });
    }
  }

  @override
  void didUpdateWidget(covariant KnowledgePane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.startRecordingRequest > 0 &&
        widget.startRecordingRequest != oldWidget.startRecordingRequest) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _handleStartRecordingRequest();
      });
    }
  }

  void _handleStartRecordingRequest() {
    if (!mounted) return;
    widget.onStartRecordingRequestHandled();
    unawaited(_startMeetingRecordingFromShortcut());
  }

  Future<void> _startMeetingRecordingFromShortcut() async {
    if (!mounted || meetingRecording || meetingSaving || uploading) return;
    await toggleMeetingRecording();
  }

  @override
  void dispose() {
    meetingTimer?.cancel();
    documentRefreshTimer?.cancel();
    super.dispose();
  }

  void scheduleDocumentRefresh() {
    documentRefreshTimer?.cancel();
    if (!documents.any(
      (document) =>
          document['status'] == 'QUEUED' || document['status'] == 'PROCESSING',
    )) {
      return;
    }
    documentRefreshTimer = Timer(const Duration(seconds: 3), () {
      if (mounted) unawaited(load());
    });
  }

  Future<void> load() async {
    try {
      final values = await Future.wait([
        widget.api.knowledge(),
        widget.api.documents(),
        widget.meetingRecorder.pendingCount(),
      ]);
      if (mounted) {
        final completedResearchIds = hasLoadedDocuments
            ? (values[1] as List<Map<String, dynamic>>)
                  .where(
                    (document) =>
                        _isResearch(document) &&
                        document['status'] == 'COMPLETE' &&
                        documents.any(
                          (previous) =>
                              previous['id'] == document['id'] &&
                              previous['status'] != 'COMPLETE',
                        ),
                  )
                  .map((document) => document['id'])
                  .toList()
            : const <dynamic>[];
        setState(() {
          items = values[0] as List<KnowledgeItem>;
          documents = values[1] as List<Map<String, dynamic>>;
          pendingRecordingCount = values[2] as int;
          error = null;
          hasLoadedDocuments = true;
        });
        if (completedResearchIds.isNotEmpty) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('研究报告已完成，可以打开查看')));
        }
        scheduleDocumentRefresh();
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> upload() async {
    if (widget.api.isGuest) {
      setState(() => error = '请先登录后再拍照或上传资料');
      return;
    }
    try {
      final picked = await documentChannel.invokeMapMethod<String, dynamic>(
        'pick',
      );
      if (picked == null || !mounted) return;
      final bytes = picked['bytes'] as Uint8List?;
      final fileName = picked['fileName'] as String? ?? '资料';
      final mimeType =
          picked['mimeType'] as String? ?? 'application/octet-stream';
      if (bytes == null || bytes.isEmpty) throw const ApiException('文件内容为空');
      final note = await requestUploadNote(fileName);
      if (note == null || !mounted) return;
      setState(() {
        uploading = true;
        error = null;
      });
      final uploadResult = await widget.api.uploadDocument(
        fileName: fileName,
        mimeType: mimeType,
        bytes: bytes,
        note: note,
      );
      await load();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              uploadResult['noteAppended'] == true
                  ? '资料已存在，补充说明已追加'
                  : uploadResult['duplicate'] == true
                  ? '这份资料已经存在，没有重复归档'
                  : '资料已保存，以后可直接询问',
            ),
          ),
        );
      }
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (mounted) setState(() => uploading = false);
    }
  }

  Future<void> toggleMeetingRecording() async {
    if (uploading || meetingSaving) return;
    if (!meetingRecording) {
      if (widget.api.isGuest) {
        setState(() => error = '请先登录后再保存录音资料');
        return;
      }
      try {
        await widget.meetingRecorder.start(
          onProgress: (count) {
            if (mounted) setState(() => meetingProcessedChunks = count);
          },
        );
        if (mounted) {
          setState(() {
            meetingRecording = true;
            meetingStartedAt = DateTime.now();
            meetingElapsed = Duration.zero;
            error = null;
          });
          _startMeetingTimer();
        }
      } catch (exception) {
        if (mounted) setState(() => error = exception.toString());
      }
      return;
    }
    setState(() {
      meetingRecording = false;
      meetingSaving = true;
      error = null;
    });
    meetingTimer?.cancel();
    await widget.meetingRecorder.beginProcessing();
    try {
      final result = await widget.meetingRecorder.stop();
      await _archiveRecording(result);
      await load();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('录音已安全上传，服务器会在后台继续整理')));
      }
    } catch (exception) {
      if (mounted) {
        final count = await widget.meetingRecorder.pendingCount();
        setState(() {
          pendingRecordingCount = count;
          error = '上传暂未完成，录音仍安全保存在本机，可点击“立即重试”';
        });
      }
    } finally {
      await widget.meetingRecorder.endProcessing();
      if (mounted) {
        setState(() {
          meetingSaving = false;
          meetingStartedAt = null;
          meetingElapsed = Duration.zero;
          meetingProcessedChunks = 0;
        });
      }
    }
  }

  void _startMeetingTimer() {
    meetingTimer?.cancel();
    meetingTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || meetingStartedAt == null) return;
      setState(() {
        meetingElapsed = DateTime.now().difference(meetingStartedAt!);
      });
    });
  }

  Future<void> _archiveRecording(PersistentMeetingResult result) async {
    final timestamp = DateFormat('yyyyMMdd-HHmmss').format(result.createdAt);
    await widget.api.uploadDocument(
      fileName: '会议录音-$timestamp.wav',
      mimeType: 'audio/wav',
      bytes: result.wav,
      note: result.transcript.isEmpty
          ? '会议/谈话录音。转写暂时失败，原始录音已保留。'
          : '会议/谈话录音自动转写：\n${result.transcript}',
      waitForProcessing: false,
    );
    await widget.meetingRecorder.markUploaded(result.sessionId);
  }

  Future<void> retryPendingRecordings() async {
    if (retryingRecordings || meetingRecording || meetingSaving) return;
    setState(() {
      retryingRecordings = true;
      error = null;
    });
    await widget.meetingRecorder.beginProcessing();
    try {
      final recovered = await widget.meetingRecorder.recoverPending();
      for (final result in recovered) {
        await _archiveRecording(result);
      }
      await load();
      if (mounted && recovered.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('已重新上传 ${recovered.length} 段录音，服务器正在后台整理')),
        );
      }
    } catch (_) {
      if (mounted) {
        final count = await widget.meetingRecorder.pendingCount();
        setState(() {
          pendingRecordingCount = count;
          error = '仍未连接成功，录音保存在本机，网络恢复后可再次重试';
        });
      }
    } finally {
      await widget.meetingRecorder.endProcessing();
      if (mounted) setState(() => retryingRecordings = false);
    }
  }

  Future<String?> requestUploadNote(String fileName) async {
    return showDialog<String>(
      context: context,
      builder: (context) =>
          _UploadNoteDialog(api: widget.api, fileName: fileName),
    );
  }

  String documentTitle(Map<String, dynamic> document) {
    final result = document['result'] as Map<String, dynamic>?;
    return result?['title'] as String? ??
        document['fileName'] as String? ??
        '资料';
  }

  bool _isResearch(Map<String, dynamic> document) =>
      document['mimeType'] == 'application/vnd.daynote.research+json' ||
      document['storageKind'] == 'research';

  String categoryOf(Map<String, dynamic> document) {
    if (_isResearch(document)) return '研究报告';
    final result = document['result'] as Map<String, dynamic>?;
    final category = result?['category'] as String? ?? '其他';
    final mimeType = document['mimeType'] as String? ?? '';
    if (mimeType.startsWith('audio/')) return '会议录音';

    final title = documentTitle(document);
    final summary = result?['summary'] as String? ?? '';
    final notes = (document['notes'] as List<dynamic>? ?? const [])
        .whereType<String>()
        .join(' ');
    final explicitlyNotAMistake = RegExp(
      r'不是错题|并非错题|非错题|误分.{0,6}错题|不要.{0,6}错题',
    ).hasMatch('$title $notes');
    final explicitlyMarkedAsMistake =
        !explicitlyNotAMistake &&
        (title.contains('错题') || RegExp(r'错题|做错|答错|错因|错误答案').hasMatch(notes));
    final hasExerciseEvidence = RegExp(
      r'题目|解题|作答|错因|错误答案|正确答案|计算题|选择题|填空题|得分',
    ).hasMatch('$title $summary $notes');
    if (explicitlyMarkedAsMistake ||
        (category == '错题' && hasExerciseEvidence)) {
      return '错题';
    }
    if (category == '错题') return '其他';
    return category;
  }

  String _durationLabel(Duration duration) {
    final hours = duration.inHours;
    final minutes = duration.inMinutes.remainder(60).toString().padLeft(2, '0');
    final seconds = duration.inSeconds.remainder(60).toString().padLeft(2, '0');
    return hours > 0 ? '$hours:$minutes:$seconds' : '$minutes:$seconds';
  }

  Future<void> addNote(Map<String, dynamic> document) async {
    final note = await showDialog<String>(
      context: context,
      builder: (context) => _UploadNoteDialog(
        api: widget.api,
        fileName: documentTitle(document),
        confirmLabel: '保存说明',
      ),
    );
    if (note == null || note.trim().isEmpty || !mounted) return;
    setState(() {
      uploading = true;
      error = null;
    });
    try {
      await widget.api.addDocumentNote(document['id'] as String, note);
      await load();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('补充说明已保存')));
      }
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (mounted) setState(() => uploading = false);
    }
  }

  Widget _researchBullet(String text, {Color? color}) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 7),
          child: Container(
            width: 5,
            height: 5,
            decoration: BoxDecoration(
              color: color ?? const Color(0xffd97706),
              shape: BoxShape.circle,
            ),
          ),
        ),
        const SizedBox(width: 9),
        Expanded(
          child: SelectableText(text, style: const TextStyle(height: 1.5)),
        ),
      ],
    ),
  );

  void _showResearchDocument(Map<String, dynamic> document) {
    final result = document['result'] as Map<String, dynamic>?;
    final status = document['status'] as String? ?? 'QUEUED';
    final takeaways = (result?['keyTakeaways'] as List<dynamic>? ?? const [])
        .whereType<String>()
        .toList();
    final sections = (result?['sections'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .toList();
    final actions = (result?['practicalActions'] as List<dynamic>? ?? const [])
        .whereType<String>()
        .toList();
    final cautions = (result?['cautions'] as List<dynamic>? ?? const [])
        .whereType<String>()
        .toList();
    final sources = (result?['sources'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .toList();
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: FractionallySizedBox(
          heightFactor: .92,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(22, 0, 22, 30),
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.science_outlined, color: Color(0xff7c3aed)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      result?['title'] as String? ?? documentTitle(document),
                      style: const TextStyle(
                        fontSize: 21,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
              if (status != 'COMPLETE') ...[
                const SizedBox(height: 50),
                Center(
                  child: Column(
                    children: [
                      if (status == 'FAILED')
                        const Icon(
                          Icons.error_outline_rounded,
                          size: 42,
                          color: Color(0xffdc2626),
                        )
                      else
                        const CircularProgressIndicator(),
                      const SizedBox(height: 16),
                      Text(
                        status == 'FAILED'
                            ? '研究暂未完成，请稍后重新发起'
                            : 'GPT-5.6 Sol 正在搜索、核对和整理资料…',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: Color(0xff716b63)),
                      ),
                    ],
                  ),
                ),
              ] else ...[
                const SizedBox(height: 8),
                Text(
                  '研究完成于 ${result?['researchedAt'] ?? ''}',
                  style: const TextStyle(
                    fontSize: 11,
                    color: Color(0xff8a8680),
                  ),
                ),
                const SizedBox(height: 18),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: const Color(0xfffff7ed),
                    borderRadius: BorderRadius.circular(15),
                  ),
                  child: SelectableText(
                    result?['executiveSummary'] as String? ?? '',
                    style: const TextStyle(fontSize: 15, height: 1.6),
                  ),
                ),
                if (takeaways.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  const Text(
                    '先看结论',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 10),
                  for (final item in takeaways) _researchBullet(item),
                ],
                for (final section in sections) ...[
                  const SizedBox(height: 20),
                  Text(
                    section['heading'] as String? ?? '详细分析',
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  SelectableText(
                    section['content'] as String? ?? '',
                    style: const TextStyle(
                      height: 1.65,
                      color: Color(0xff44403c),
                    ),
                  ),
                ],
                if (actions.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  const Text(
                    '可以怎么做',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 10),
                  for (final item in actions)
                    _researchBullet(item, color: const Color(0xff16a34a)),
                ],
                if (cautions.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  const Text(
                    '注意与边界',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 10),
                  for (final item in cautions)
                    _researchBullet(item, color: const Color(0xffdc2626)),
                ],
                if (sources.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  Text(
                    '核对来源（${sources.length}）',
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 8),
                  for (final source in sources)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.open_in_new_rounded, size: 19),
                      title: Text(source['title'] as String? ?? '来源'),
                      subtitle: Text(
                        [source['publisher'], source['publishedAt']]
                            .whereType<String>()
                            .where((value) => value.isNotEmpty)
                            .join(' · '),
                      ),
                      onTap: () {
                        final uri = Uri.tryParse(
                          source['url'] as String? ?? '',
                        );
                        if (uri != null) {
                          launchUrl(uri, mode: LaunchMode.externalApplication);
                        }
                      },
                    ),
                ],
              ],
            ],
          ),
        ),
      ),
    );
  }

  void showDocument(Map<String, dynamic> document) {
    if (_isResearch(document)) {
      _showResearchDocument(document);
      return;
    }
    final result = document['result'] as Map<String, dynamic>? ?? const {};
    final people = (result['people'] as List<dynamic>? ?? const [])
        .cast<String>();
    final keywords = (result['keywords'] as List<dynamic>? ?? const [])
        .cast<String>();
    final warnings = (result['warnings'] as List<dynamic>? ?? const [])
        .cast<String>();
    final notes = (document['notes'] as List<dynamic>? ?? const [])
        .cast<String>();
    final isAudio = (document['mimeType'] as String? ?? '').startsWith(
      'audio/',
    );
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(22, 0, 22, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      documentTitle(document),
                      style: const TextStyle(
                        fontSize: 21,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.pop(context),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
              const SizedBox(height: 7),
              Text(
                '${result['category'] ?? '其他'}${(result['documentDate'] as String? ?? '').isEmpty ? '' : ' · ${result['documentDate']}'}',
                style: const TextStyle(color: Color(0xff8a8680)),
              ),
              if ((result['summary'] as String? ?? '').isNotEmpty) ...[
                const SizedBox(height: 18),
                Text(
                  result['summary'] as String,
                  style: const TextStyle(height: 1.55),
                ),
              ],
              if (people.isNotEmpty) _detailLine('相关人员', people.join('、')),
              if (keywords.isNotEmpty) _detailLine('关键词', keywords.join('、')),
              if (notes.isNotEmpty) _detailLine('我的说明', notes.join('\n\n')),
              if (isAudio)
                DocumentAudioPlayer(
                  api: widget.api,
                  documentId: document['id'] as String,
                  byteSize: (document['byteSize'] as num?)?.toInt() ?? 0,
                ),
              _detailLine('原文件', document['fileName'] as String? ?? '资料'),
              if (warnings.isNotEmpty) _detailLine('识别提示', warnings.join('\n')),
              const SizedBox(height: 18),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: document['status'] == 'COMPLETE'
                      ? () {
                          Navigator.pop(context);
                          addNote(document);
                        }
                      : null,
                  icon: const Icon(Icons.add_comment_outlined),
                  label: const Text('补充说明（支持语音）'),
                ),
              ),
              const SizedBox(height: 18),
              Container(
                padding: const EdgeInsets.all(13),
                decoration: BoxDecoration(
                  color: const Color(0xfffff7ed),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      Icons.lock_outline_rounded,
                      size: 18,
                      color: Color(0xffb45309),
                    ),
                    SizedBox(width: 9),
                    Expanded(
                      child: Text(
                        '原始文件保存在这台 Mac 的 Obsidian「家庭资料」库中，手机这里只展示归档信息。',
                        style: TextStyle(color: Color(0xff92400e), height: 1.4),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _detailLine(String label, String value) => Padding(
    padding: const EdgeInsets.only(top: 14),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(fontSize: 12, color: Color(0xff9a948b)),
        ),
        const SizedBox(height: 4),
        Text(value, style: const TextStyle(height: 1.45)),
      ],
    ),
  );

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

  void showKnowledgeItem(KnowledgeItem item) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 0, 22, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Icon(
                    Icons.lightbulb_outline_rounded,
                    color: Color(0xff8b5e34),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      item.title,
                      style: const TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: () => Navigator.pop(sheetContext),
                    icon: const Icon(Icons.close_rounded),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              SelectableText(
                item.content,
                style: const TextStyle(height: 1.55, color: Color(0xff514c46)),
              ),
              const SizedBox(height: 22),
              Row(
                children: [
                  const Chip(label: Text('笔记')),
                  const Spacer(),
                  TextButton.icon(
                    onPressed: () {
                      Navigator.pop(sheetContext);
                      unawaited(remove(item));
                    },
                    icon: const Icon(Icons.delete_outline_rounded),
                    label: const Text('删除'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final categories = <String>{
      '全部',
      if (items.isNotEmpty) '笔记',
      if (documents.any(_isResearch)) '研究报告',
      '错题',
      '会议录音',
      ...documents
          .where((item) => item['status'] == 'COMPLETE')
          .map(categoryOf),
    }.toList();
    final showKnowledgeItems =
        documentCategory == '全部' || documentCategory == '笔记';
    final visibleDocuments = documentCategory == '笔记'
        ? <Map<String, dynamic>>[]
        : documentCategory == '全部'
        ? documents
        : documents
              .where((item) => categoryOf(item) == documentCategory)
              .toList();
    final hasVisibleContent =
        visibleDocuments.isNotEmpty || (showKnowledgeItems && items.isNotEmpty);
    final totalCount = documents.length + items.length;
    return loading
        ? const Center(child: CircularProgressIndicator())
        : RefreshIndicator(
            onRefresh: load,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: const Color(0xffffead5),
                    borderRadius: BorderRadius.circular(15),
                  ),
                  child: const Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        Icons.auto_awesome_rounded,
                        color: Color(0xffb45f06),
                      ),
                      SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          '资料、笔记、研究报告、合同和孩子错题都保存在这里。说“帮我研究…”后，报告会在后台完成。',
                          style: TextStyle(
                            color: Color(0xff8f4f0b),
                            height: 1.45,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed:
                            uploading || meetingRecording || meetingSaving
                            ? null
                            : upload,
                        icon: uploading
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.add_a_photo_outlined),
                        label: Text(uploading ? '正在保存…' : '拍照 / 上传'),
                      ),
                    ),
                    const SizedBox(width: 9),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: uploading || meetingSaving
                            ? null
                            : toggleMeetingRecording,
                        style: FilledButton.styleFrom(
                          backgroundColor: meetingRecording
                              ? const Color(0xffdc2626)
                              : const Color(0xff1a1a1e),
                        ),
                        icon: meetingSaving
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: Colors.white,
                                ),
                              )
                            : Icon(
                                meetingRecording
                                    ? Icons.stop_rounded
                                    : Icons.mic_rounded,
                              ),
                        label: Text(
                          meetingSaving
                              ? '正在转写…'
                              : meetingRecording
                              ? '停止并保存'
                              : '快速录音',
                        ),
                      ),
                    ),
                  ],
                ),
                if (meetingRecording)
                  Padding(
                    padding: const EdgeInsets.only(top: 9),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(
                          Icons.fiber_manual_record,
                          size: 12,
                          color: Color(0xffdc2626),
                        ),
                        const SizedBox(width: 5),
                        Text(
                          '${_durationLabel(meetingElapsed)} · 已后台处理 $meetingProcessedChunks 段 · 锁屏仍继续',
                          style: const TextStyle(
                            fontSize: 11,
                            color: Color(0xffb42318),
                          ),
                        ),
                      ],
                    ),
                  ),
                const SizedBox(height: 14),
                if (pendingRecordingCount > 0)
                  Container(
                    margin: const EdgeInsets.only(bottom: 12),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xfffff3cd),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Row(
                      children: [
                        const Icon(
                          Icons.cloud_upload_outlined,
                          color: Color(0xff8a5a00),
                        ),
                        const SizedBox(width: 9),
                        Expanded(
                          child: Text(
                            '有 $pendingRecordingCount 段录音保存在本机，尚未完成上传',
                            style: const TextStyle(color: Color(0xff704800)),
                          ),
                        ),
                        TextButton(
                          onPressed: retryingRecordings
                              ? null
                              : retryPendingRecordings,
                          child: Text(retryingRecordings ? '重试中…' : '立即重试'),
                        ),
                      ],
                    ),
                  ),
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
                if (totalCount > 0) ...[
                  Row(
                    children: [
                      const Expanded(
                        child: Text(
                          '资料分类',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      Text(
                        '$totalCount 项',
                        style: const TextStyle(
                          fontSize: 12,
                          color: Color(0xff8a8680),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 9),
                  SizedBox(
                    height: 38,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: categories.length,
                      separatorBuilder: (_, _) => const SizedBox(width: 7),
                      itemBuilder: (_, index) {
                        final category = categories[index];
                        return ChoiceChip(
                          label: Text(category),
                          selected: documentCategory == category,
                          onSelected: (_) =>
                              setState(() => documentCategory = category),
                        );
                      },
                    ),
                  ),
                  const SizedBox(height: 10),
                ],
                if (visibleDocuments.isNotEmpty) ...[
                  for (final document in visibleDocuments)
                    InkWell(
                      onTap: () => showDocument(document),
                      borderRadius: BorderRadius.circular(15),
                      child: Container(
                        margin: const EdgeInsets.only(bottom: 9),
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(15),
                          border: Border.all(
                            color: Colors.black.withValues(alpha: .06),
                          ),
                        ),
                        child: Row(
                          children: [
                            Icon(
                              _isResearch(document)
                                  ? Icons.science_outlined
                                  : Icons.description_outlined,
                              color: _isResearch(document)
                                  ? const Color(0xff7c3aed)
                                  : const Color(0xff8b5e34),
                            ),
                            const SizedBox(width: 11),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    documentTitle(document),
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                  const SizedBox(height: 3),
                                  Align(
                                    alignment: Alignment.centerLeft,
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 8,
                                        vertical: 3,
                                      ),
                                      decoration: BoxDecoration(
                                        color: const Color(0xffffead5),
                                        borderRadius: BorderRadius.circular(
                                          999,
                                        ),
                                      ),
                                      child: Text(
                                        document['status'] == 'COMPLETE'
                                            ? categoryOf(document)
                                            : document['status'] == 'FAILED'
                                            ? '处理失败'
                                            : '正在处理',
                                        style: const TextStyle(
                                          color: Color(0xff8f4f0b),
                                          fontSize: 11,
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const Icon(
                              Icons.chevron_right_rounded,
                              color: Color(0xffb7b0a7),
                            ),
                          ],
                        ),
                      ),
                    ),
                ],
                if (items.isEmpty && documents.isEmpty)
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
                          '还没有资料',
                          style: TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        SizedBox(height: 8),
                        Text(
                          '上传 PDF、Word、图片或文本\n也可以继续用语音保存知识',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Color(0xff8a8680)),
                        ),
                      ],
                    ),
                  )
                else if (showKnowledgeItems)
                  for (final item in items)
                    InkWell(
                      onTap: () => showKnowledgeItem(item),
                      borderRadius: BorderRadius.circular(15),
                      child: Container(
                        margin: const EdgeInsets.only(bottom: 9),
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(15),
                          border: Border.all(
                            color: Colors.black.withValues(alpha: .06),
                          ),
                        ),
                        child: Row(
                          children: [
                            const Icon(
                              Icons.lightbulb_outline_rounded,
                              color: Color(0xff8b5e34),
                            ),
                            const SizedBox(width: 11),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    item.title,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                  const SizedBox(height: 3),
                                  Align(
                                    alignment: Alignment.centerLeft,
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 8,
                                        vertical: 3,
                                      ),
                                      decoration: BoxDecoration(
                                        color: const Color(0xffffead5),
                                        borderRadius: BorderRadius.circular(
                                          999,
                                        ),
                                      ),
                                      child: const Text(
                                        '笔记',
                                        style: TextStyle(
                                          color: Color(0xff8f4f0b),
                                          fontSize: 11,
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const Icon(
                              Icons.chevron_right_rounded,
                              color: Color(0xffb7b0a7),
                            ),
                          ],
                        ),
                      ),
                    ),
                if (totalCount > 0 && !hasVisibleContent)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 70),
                    child: Center(
                      child: Text(
                        '这个分类暂时没有内容',
                        style: TextStyle(color: Color(0xff8a8680)),
                      ),
                    ),
                  ),
              ],
            ),
          );
  }
}

class _KnowledgeAnswerDialog extends StatelessWidget {
  const _KnowledgeAnswerDialog({required this.answer, required this.sources});

  final String answer;
  final List<Map<String, dynamic>> sources;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Row(
        children: [
          Icon(Icons.auto_awesome_rounded, size: 21),
          SizedBox(width: 8),
          Text('知识库回答'),
        ],
      ),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SelectableText(
                answer,
                style: const TextStyle(fontSize: 16, height: 1.6),
              ),
              if (sources.isNotEmpty) ...[
                const SizedBox(height: 18),
                const Divider(height: 1),
                const SizedBox(height: 14),
                Text(
                  '依据资料（${sources.length}）',
                  style: Theme.of(
                    context,
                  ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 10),
                for (var index = 0; index < sources.length; index++) ...[
                  _AnswerSourceCard(index: index + 1, source: sources[index]),
                  if (index != sources.length - 1) const SizedBox(height: 10),
                ],
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('知道了'),
        ),
      ],
    );
  }
}

class _AnswerSourceCard extends StatelessWidget {
  const _AnswerSourceCard({required this.index, required this.source});

  final int index;
  final Map<String, dynamic> source;

  @override
  Widget build(BuildContext context) {
    final sourceType = source['sourceType'] as String? ?? 'knowledge';
    final mimeType = source['mimeType'] as String? ?? '';
    final isDocument = sourceType == 'document';
    final isDerived = source['sourceKind'] == 'derived';
    final isImage = isDocument && mimeType.startsWith('image/');
    final title = (source['title'] as String? ?? '资料').trim();
    final excerpt = (source['content'] as String? ?? '').trim();
    final category = (source['category'] as String? ?? '').trim();
    final evidenceLabel = isDerived
        ? '整理记录摘录'
        : isImage
        ? '图片识别文字'
        : isDocument
        ? '原文摘录'
        : '知识库原文';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xfffffbeb),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xfffde68a)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                isImage
                    ? Icons.image_outlined
                    : isDocument
                    ? Icons.description_outlined
                    : Icons.notes_rounded,
                size: 19,
                color: const Color(0xffb45309),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '$index. $title',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                    height: 1.35,
                  ),
                ),
              ),
            ],
          ),
          if (category.isNotEmpty) ...[
            const SizedBox(height: 5),
            Text(
              category,
              style: const TextStyle(fontSize: 12, color: Color(0xff78716c)),
            ),
          ],
          if (excerpt.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(
              evidenceLabel,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: Color(0xff92400e),
              ),
            ),
            const SizedBox(height: 4),
            SelectableText(
              excerpt,
              style: const TextStyle(
                fontSize: 13,
                height: 1.5,
                color: Color(0xff44403c),
              ),
            ),
          ],
          if (isImage) ...[
            const SizedBox(height: 8),
            const Text(
              '原图保存在家庭 Mac 中，以上内容由图片识别生成，请结合原图核对。',
              style: TextStyle(
                fontSize: 11,
                height: 1.4,
                color: Color(0xff78716c),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _UploadNoteDialog extends StatefulWidget {
  const _UploadNoteDialog({
    required this.api,
    required this.fileName,
    this.confirmLabel = '确认上传',
  });

  final ApiClient api;
  final String fileName;
  final String confirmLabel;

  @override
  State<_UploadNoteDialog> createState() => _UploadNoteDialogState();
}

class _UploadNoteDialogState extends State<_UploadNoteDialog> {
  late final VoiceService voice = VoiceService(widget.api);
  final controller = TextEditingController();
  bool recording = false;
  bool transcribing = false;
  String? error;

  @override
  void dispose() {
    controller.dispose();
    unawaited(voice.dispose());
    super.dispose();
  }

  Future<void> toggleVoice() async {
    if (transcribing) return;
    if (!recording) {
      try {
        await voice.start();
        if (mounted) {
          setState(() {
            recording = true;
            error = null;
          });
        }
      } catch (exception) {
        if (mounted) setState(() => error = exception.toString());
      }
      return;
    }
    setState(() {
      recording = false;
      transcribing = true;
      error = null;
    });
    try {
      final text = (await voice.transcribe(await voice.stopRecording())).trim();
      if (text.isEmpty) throw const ApiException('没有听清，请再说一次');
      final previous = controller.text.trim();
      final combined = '${previous.isEmpty ? '' : '$previous\n'}$text';
      controller.text = combined.length > 1000
          ? combined.substring(0, 1000)
          : combined;
      controller.selection = TextSelection.collapsed(
        offset: controller.text.length,
      );
    } catch (exception) {
      if (mounted) setState(() => error = exception.toString());
    } finally {
      if (mounted) setState(() => transcribing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final busy = recording || transcribing;
    return AlertDialog(
      title: const Text('说一下这是什么'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.fileName,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, color: Color(0xff8a8680)),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              minLines: 3,
              maxLines: 6,
              maxLength: 1000,
              decoration: const InputDecoration(
                hintText: '例如：这是孩子今天的数学错题，主要是分数通分不会。也可以留空。',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 2),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: transcribing ? null : toggleVoice,
                icon: transcribing
                    ? const SizedBox(
                        width: 17,
                        height: 17,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Icon(
                        recording
                            ? Icons.stop_circle_rounded
                            : Icons.mic_none_rounded,
                        color: recording ? const Color(0xffdc2626) : null,
                      ),
                label: Text(
                  transcribing
                      ? '正在识别…'
                      : recording
                      ? '正在录音，点此结束'
                      : '按一下，说一两句',
                ),
              ),
            ),
            if (error != null) ...[
              const SizedBox(height: 8),
              Text(
                error!,
                style: const TextStyle(fontSize: 12, color: Color(0xffb42318)),
              ),
            ],
            const SizedBox(height: 6),
            const Text(
              '照片、OCR 文字和这段说明会一起保存，以后可以直接问或生成同类练习。',
              style: TextStyle(fontSize: 12, color: Color(0xff8a8680)),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: busy ? null : () => Navigator.pop(context),
          child: const Text('取消'),
        ),
        FilledButton(
          onPressed: busy
              ? null
              : () => Navigator.pop(context, controller.text.trim()),
          child: Text(widget.confirmLabel),
        ),
      ],
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
                  entry.displayDescription,
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
                if (entry.scheduledDate != null &&
                    entry.reminderAt == null) ...[
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      const Icon(
                        Icons.calendar_today_rounded,
                        size: 13,
                        color: Color(0xff8a8680),
                      ),
                      const SizedBox(width: 4),
                      Text(
                        DateFormat(
                          'M月d日',
                          'zh_CN',
                        ).format(DateTime.parse(entry.scheduledDate!)),
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: Color(0xff8a8680),
                        ),
                      ),
                    ],
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
