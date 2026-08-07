// 临时 Webhook 接收器:接收推送,打印并写入 received.json
const http = require('http');
const fs = require('fs');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const entry = { time: new Date().toISOString(), headers: req.headers, body: JSON.parse(body || '{}') };
    console.log('=== WEBHOOK RECEIVED ===');
    console.log('secret:', req.headers['x-webhook-secret'] || '(none)');
    console.log(JSON.stringify(entry.body, null, 2));
    fs.appendFileSync(__dirname + '/received.json', JSON.stringify(entry) + '\n');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});
server.listen(4321, () => console.log('webhook receiver on :4321'));
