// static-audio.js
// 无延迟方案：开页即拉取 tts-manifest.json，建立 window.__AUDIO_MAP
// manifest 值使用相对路径（如 "audio/xxxx.mp3"），
// 因此在 Vercel 根路径与 GitHub Pages 子路径 (/CAPLEA1/) 下都能正确解析。
// 拉取失败时降级为空对象，前端自动 fallback 到 /api/tts（live 合成）。
(function () {
  window.__AUDIO_MAP = null;
  window.__AUDIO_READY = false;
  function load() {
    fetch('tts-manifest.json', { cache: 'no-cache' })
      .then(function (r) { return r.json(); })
      .then(function (m) { window.__AUDIO_MAP = m || {}; window.__AUDIO_READY = true; })
      .catch(function () { window.__AUDIO_MAP = {}; window.__AUDIO_READY = true; });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
