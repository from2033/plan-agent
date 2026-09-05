import { runOllama } from "./codex-worker.mjs";

const context = { currentDate: "2026-09-02", currentTime: "13:00", timeZone: "Asia/Shanghai" };
const cases = [
  { name: "重复口述的今晚提醒", raw: "今天六点今天晚上6点40，提醒我把这个风扇带上去充电。", type: "memo", date: "2026-09-02", time: "18:40" },
  { name: "今晚提醒", raw: "今晚6点40提醒我把那个风扇带上去充电。", type: "memo", date: "2026-09-02", time: "18:40" },
  { name: "明天下午提醒", raw: "明天下午3点提醒我给张老师打电话。", type: "memo", date: "2026-09-03", time: "15:00" },
  { name: "后天早晨提醒", raw: "后天早上8点提醒我带材料。", type: "memo", date: "2026-09-04", time: "08:00" },
  { name: "今晚十二点跨日", raw: "今晚12点提醒我上线。", type: "memo", date: "2026-09-03", time: "00:00" },
  { name: "体重不是消费", raw: "记录9月2号体重120.7斤。", type: "activity", date: "2026-09-02" },
  { name: "正常消费", raw: "午饭花了38元。", type: "expense", amount: 38 },
  { name: "普通活动", raw: "记录今天跑步30分钟。", type: "activity", date: "2026-09-02" },
];

let failures = 0;
for (const item of cases) {
  const startedAt = Date.now();
  try {
    const result = await runOllama({
      kind: "ingest",
      input: { raw: item.raw, inputMode: "voice", interactionMode: "home", context, knowledge: [] },
    }, { model: "qwen3:14b", timeoutMs: 120_000, keepAlive: "5m" });
    const field = result.fields?.[0];
    const passed = result.kind === "record"
      && field?.type === item.type
      && (item.date === undefined || field.date === item.date)
      && (item.time === undefined || field.reminderTime === item.time)
      && (item.amount === undefined || field.amount === item.amount);
    if (!passed) failures += 1;
    console.log(JSON.stringify({ name: item.name, passed, elapsedMs: Date.now() - startedAt, result }));
  } catch (error) {
    failures += 1;
    console.log(JSON.stringify({ name: item.name, passed: false, elapsedMs: Date.now() - startedAt, error: String(error) }));
  }
}

if (failures) {
  console.error(`ingest model evaluation failed: ${failures}/${cases.length}`);
  process.exitCode = 1;
} else {
  console.log(`ingest model evaluation passed: ${cases.length}/${cases.length}`);
}
