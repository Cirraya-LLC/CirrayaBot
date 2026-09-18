/// Strings for the state area (workbench controller and API errors):
/// key -> ['English', '简体', '繁體'].
library;

const Map<String, List<String>> stateStrings = {
  // API failures
  'api.unreachable': ["Can't reach the server", '连不上服务器', '連不上伺服器'],
  'api.unreachableDetail': ["Can't reach the server: {detail}", '连不上服务器：{detail}', '連不上伺服器：{detail}'],
  'api.unauthorized': [
    'The access token is wrong, or the server has a new one',
    '访问令牌不对，或者服务端换了一个',
    '存取權杖不對，或者伺服器換了一個',
  ],
  'api.server': ['Server error', '服务器出错', '伺服器出錯'],
  'api.serverDetail': ['Server error: {detail}', '服务器出错：{detail}', '伺服器出錯：{detail}'],
  'api.badUrl': [
    'The server address is malformed — it should look like http://192.168.1.10:8080',
    '服务器地址格式不对，要像 http://192.168.1.10:8080 这样',
    '伺服器位址格式不對，要像 http://192.168.1.10:8080 這樣',
  ],
  'api.tls': [
    'TLS handshake failed (if the server is plain http, don\'t write https): {detail}',
    'TLS 握手失败（服务器是 http 的话，地址别写成 https）：{detail}',
    'TLS 交握失敗（伺服器是 http 的話，位址別寫成 https）：{detail}',
  ],
  'api.notJson': [
    "The server didn't answer JSON — the address or port may point at another service",
    '服务器回的不是 JSON —— 地址或端口可能指到了别的服务',
    '伺服器回的不是 JSON —— 位址或連接埠可能指到了別的服務',
  ],
  'api.badShape': [
    "The server's answer has the wrong shape — the address may point at another service",
    '服务器回的格式不对 —— 地址可能指到了别的服务',
    '伺服器回的格式不對 —— 位址可能指到了別的服務',
  ],
  'api.notJsonFile': ['This file is not JSON', '这个文件不是 JSON', '這個檔案不是 JSON'],
  'api.shotFailed': ['Screenshot failed ({code})', '截图失败（{code}）', '截圖失敗（{code}）'],
  'api.streamFailed': [
    "Couldn't connect to the live view ({code})",
    '实时画面连不上（{code}）',
    '即時畫面連不上（{code}）',
  ],
  'api.browserRefused': ["The browser didn't do it", '浏览器没有照做', '瀏覽器沒有照做'],
  'api.silent': [
    'Nothing from the server for 5 minutes — stopping this turn',
    '5 分钟没收到服务器的任何动静，这一轮先停下',
    '5 分鐘沒收到伺服器的任何動靜，這一輪先停下',
  ],

  // Transcript notes
  'state.retry': ['{name} retrying: {reason}', '{name} 重试一次：{reason}', '{name} 重試一次：{reason}'],
  'state.trimmed': [
    'Context was full — dropped the earliest {n} messages',
    '上下文放不下，省掉了最早的 {n} 条',
    '上下文放不下，省略了最早的 {n} 則',
  ],
  'state.noResult': [
    '(no result came back for this command)',
    '（没有收到这条命令的结果）',
    '（沒有收到這條指令的結果）',
  ],

  // Tool card labels
  'tool.read': ['read {path}', '读 {path}', '讀 {path}'],
  'tool.write': ['write {path}', '写 {path}', '寫 {path}'],
  'tool.browser': ['Browser · {what}', '浏览器 · {what}', '瀏覽器 · {what}'],
  'tool.b.open': ['open {url}', '打开 {url}', '開啟 {url}'],
  'tool.b.read': ['read page', '读页面', '讀頁面'],
  'tool.b.screenshot': ['screenshot', '截图', '截圖'],
  'tool.b.back': ['back', '后退', '上一頁'],
  'tool.b.click': ['click {target}', '点 {target}', '點 {target}'],
  'tool.b.type': ['type “{text}” into #{index}', '在 #{index} 填「{text}」', '在 #{index} 填「{text}」'],
  'tool.b.enter': [' + Enter', ' 回车', ' Enter'],
  'tool.b.press': ['press {key}', '按 {key}', '按 {key}'],
  'tool.b.scroll': ['scroll', '滚动', '捲動'],
  'tool.b.eval': ['run JS', '执行 JS', '執行 JS'],
  'tool.b.quoted': ['“{text}”', '「{text}」', '「{text}」'],
};
