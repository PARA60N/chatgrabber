// Runs in offscreen document context.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen-download') return;
  let filename = 'download.bin';
  let mime = 'application/octet-stream';
  const chunks = [];
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'DOWNLOAD_BEGIN') {
      filename = msg.filename || filename;
      mime = msg.mime || mime;
    } else if (msg?.type === 'DOWNLOAD_CHUNK') {
      const chunk = msg.chunk;
      chunks.push(chunk);
    } else if (msg?.type === 'DOWNLOAD_END') {
      const blob = new Blob(chunks, { type: mime });
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({ url, filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      chunks.length = 0;
    }
  });
});


