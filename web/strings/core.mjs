// Messages for core code: key -> ['English', '简体', '繁體']. See ../i18n.mjs.
export const coreStrings = {
  // schedule.mjs
  'schedule.badTimeZone': ['Unknown time zone {tz}', '不认识的时区 {tz}', '無法辨識的時區 {tz}'],
  'schedule.tooShort': ['The interval must be at least {min} minutes', '间隔至少 {min} 分钟', '間隔至少 {min} 分鐘'],
  'schedule.tooLong': ['The interval can be at most 31 days', '间隔最多 31 天', '間隔最多 31 天'],
  'schedule.badTime': ['Write the time as HH:MM, e.g. 09:00', '时间要写成 HH:MM，比如 09:00', '時間請寫成 HH:MM，例如 09:00'],
  'schedule.badWeekday': ['Weekdays must be 0–6 (0 is Sunday)', '星期要是 0–6（0 是周日）', '星期必須是 0–6（0 是週日）'],
  'schedule.runAtRequired': ['Give a time to run', '要给一个运行时间', '請提供執行時間'],
  'schedule.runAtPast': ['That time has already passed', '这个时间已经过去了', '這個時間已經過去了'],
  'schedule.badKind': ['Frequency must be every N minutes, daily (or on some weekdays) at a set time, or once', '频率只能是 每隔 N 分钟 / 每天（或每周几）定点 / 只一次', '頻率只能是 每隔 N 分鐘／每天（或每週幾）定時／只執行一次'],

  // protocols.mjs
  'protocol.upstreamStatus': ['Upstream {status}: {body}', '上游 {status}：{body}', '上游 {status}：{body}'],
  'protocol.upstreamError': ['Upstream: {detail}', '上游：{detail}', '上游：{detail}'],
  'protocol.empty': ['Upstream: returned nothing this time', '上游：这一次没有返回任何内容', '上游：這一次沒有回傳任何內容'],
}
