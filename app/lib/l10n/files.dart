/// Strings for attachments: picking, uploading, previewing, saving.
library;

const Map<String, List<String>> fileStrings = {
  'att.attach': ['Attach files', '添加附件', '新增附件'],
  'att.remove': ['Remove', '移除', '移除'],
  'att.uploading': ['Uploading {pct}%', '上传中 {pct}%', '上傳中 {pct}%'],
  'att.failed': ['Not uploaded: {msg}', '没传上去：{msg}', '沒有上傳：{msg}'],
  'att.open': ['Open', '打开', '開啟'],
  'att.saveAs': ['Save as…', '另存为…', '另存新檔…'],
  'att.share': ['Share…', '分享…', '分享…'],
  'att.saved': ['Saved to {path}', '已保存到 {path}', '已儲存至 {path}'],
  'att.close': ['Close', '关闭', '關閉'],
  'att.noPreview': [
    'This kind of file can’t be previewed here — open it, or save it.',
    '这类文件没法在这里预览，可以打开或保存。',
    '這類檔案無法在這裡預覽，可以開啟或儲存。',
  ],
  'att.openHint': [
    'Opens in your system’s app for this kind of file.',
    '用系统里对应的应用打开。',
    '用系統中對應的應用程式開啟。',
  ],
  'att.cut': ['Showing the first 1 MB.', '只显示了前 1 MB。', '只顯示了前 1 MB。'],
  'att.loadFailed': ['Couldn’t load it: {msg}', '加载失败：{msg}', '載入失敗：{msg}'],
  'att.openFailed': ['Couldn’t open it: {msg}', '打不开：{msg}', '無法開啟：{msg}'],
  'att.sent': ['{name} sent a file', '{name} 发来一个文件', '{name} 傳來一個檔案'],
  'att.waitUpload': ['Still uploading — it sends when the files are up', '还在上传 —— 传完就能发', '還在上傳 —— 傳完就能傳送'],
};
