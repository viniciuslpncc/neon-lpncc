/**
 * Camada de sincronização do painel Projeto Neon · LPNCC.
 *
 * Estratégia (last-write-wins, simples e robusta):
 *
 *  1. No load, faz GET no Web App Apps Script.
 *     - Se a versão remota tem um lastModified diferente do que está cacheado
 *       em __neon_synced_at__, sobrescreve as chaves do localStorage e dá
 *       um único location.reload(). O sentinel evita loop.
 *     - Se backend está vazio (primeira vez), faz POST com o estado local
 *       atual pra inicializar.
 *
 *  2. Intercepta localStorage.setItem das chaves ALLOWED via monkey patch e
 *     dispara POST debounced (400ms) com o novo valor.
 *
 *  3. Polling de 20s pra detectar mudança feita por outro usuário. Se houver,
 *     mostra um aviso "nova versão disponível · recarregar".
 *
 *  4. Indicador visual fixo no canto (bottom-right) com 4 estados:
 *     verde (sincronizado), amarelo (salvando), cinza (offline), azul (nova versão).
 *
 *  5. Se o GET inicial falhar (offline / endpoint fora), seguimos com o estado
 *     local — a página continua funcionando como antes.
 */
(function () {
  if (window.__neonSyncReady) return;
  window.__neonSyncReady = true;

  // ====== CONFIG ======
  // *** PREENCHER COM A URL DO WEB APP APÓS O DEPLOY ***
  var ENDPOINT = 'https://script.google.com/macros/s/AKfycbwJRfuiODF-hmh2gK1-nFUcEK-3Okv2EgRZkyLCr8An384hxB8QMMKH6emk1YW0ppAR/exec';
  var ALLOWED_KEYS = ['projeto_neon_lpncc', 'neon_cc_fat'];
  var SYNC_AT_KEY = '__neon_synced_at__';
  var RELOAD_SENTINEL = '__neon_reloaded_for__';
  var POLL_MS = 20000;
  var DEBOUNCE_MS = 400;

  // Se o endpoint ainda não foi configurado, não fazemos nada — comportamento
  // original do app (localStorage puro) segue funcionando.
  if (!ENDPOINT || ENDPOINT.indexOf('__APPS_SCRIPT_ENDPOINT__') !== -1) {
    console.warn('[neon-sync] endpoint não configurado — operando só em localStorage');
    return;
  }

  // ====== INDICADOR VISUAL ======
  var ind, indDot, indTxt;
  function injectIndicator() {
    if (document.getElementById('neonSyncInd')) return;
    var style = document.createElement('style');
    style.textContent = '' +
      '#neonSyncInd{position:fixed;right:14px;bottom:14px;z-index:99999;' +
      'background:#fff;border:1px solid #E4EAEA;border-radius:20px;' +
      'padding:6px 12px 6px 10px;font:500 11.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'color:#495054;box-shadow:0 2px 6px rgba(0,70,88,.08);display:flex;align-items:center;gap:7px;' +
      'cursor:default;user-select:none;transition:all .15s ease}' +
      '#neonSyncInd .dot{width:8px;height:8px;border-radius:50%;background:#9AA3A6;flex-shrink:0;transition:background .2s}' +
      '#neonSyncInd.ok .dot{background:#3FA75A}' +
      '#neonSyncInd.busy .dot{background:#E6B800;animation:nspulse 1s ease-in-out infinite}' +
      '#neonSyncInd.off .dot{background:#9AA3A6}' +
      '#neonSyncInd.new{background:#004658;color:#fff;border-color:#004658;cursor:pointer}' +
      '#neonSyncInd.new .dot{background:#7FD4E8}' +
      '@keyframes nspulse{0%,100%{opacity:1}50%{opacity:.4}}';
    document.head.appendChild(style);
    ind = document.createElement('div');
    ind.id = 'neonSyncInd';
    ind.innerHTML = '<span class="dot"></span><span class="txt">conectando…</span>';
    indDot = ind.querySelector('.dot');
    indTxt = ind.querySelector('.txt');
    (document.body || document.documentElement).appendChild(ind);
  }
  function setInd(state, text) {
    if (!ind) return;
    ind.classList.remove('ok', 'busy', 'off', 'new');
    if (state) ind.classList.add(state);
    if (text != null) indTxt.textContent = text;
  }
  function hhmm() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // ====== AUTHOR (lido do estado existente, se houver) ======
  function currentAuthor() {
    try {
      var st = JSON.parse(localStorage.getItem('projeto_neon_lpncc') || '{}');
      return st.author || 'desconhecido';
    } catch (e) { return 'desconhecido'; }
  }

  // ====== REDE ======
  function apiGet(key) {
    var url = ENDPOINT + '?key=' + encodeURIComponent(key || 'all') + '&t=' + Date.now();
    return fetch(url, { method: 'GET', redirect: 'follow' })
      .then(function (r) { return r.json(); });
  }
  function apiPost(key, value, ifMatch) {
    var body = JSON.stringify({
      key: key, value: value, author: currentAuthor(), ifMatch: ifMatch || null
    });
    // text/plain pra evitar preflight CORS no Apps Script
    return fetch(ENDPOINT, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body
    }).then(function (r) { return r.json(); });
  }

  // ====== BOOT: pré-carrega estado remoto ======
  function boot() {
    injectIndicator();
    setInd('busy', 'conectando…');

    var localSyncedAt = localStorage.getItem(SYNC_AT_KEY);

    apiGet('all').then(function (resp) {
      if (!resp || !resp.ok) {
        setInd('off', 'offline · usando local');
        startInterception();
        startPolling();
        return;
      }

      var remoteSyncedAt = resp.lastModified;
      var stores = resp.stores || {};
      var remoteHasData = ALLOWED_KEYS.some(function (k) { return stores[k] != null; });

      // Caso 1: backend vazio → empurra estado local pra inicializar.
      if (!remoteHasData) {
        var pushes = ALLOWED_KEYS.map(function (k) {
          var raw = localStorage.getItem(k);
          if (raw == null) return Promise.resolve(null);
          try {
            return apiPost(k, JSON.parse(raw), null);
          } catch (e) { return Promise.resolve(null); }
        });
        Promise.all(pushes).then(function (results) {
          var last = results.filter(Boolean).pop();
          if (last && last.lastModified) {
            localStorage.setItem(SYNC_AT_KEY, last.lastModified);
          }
          setInd('ok', 'sincronizado · ' + hhmm());
          startInterception();
          startPolling();
        });
        return;
      }

      // Caso 2: backend tem dado e é diferente do que aplicamos por último.
      var alreadyReloadedFor = sessionStorage.getItem(RELOAD_SENTINEL);
      if (remoteSyncedAt && remoteSyncedAt !== localSyncedAt && alreadyReloadedFor !== remoteSyncedAt) {
        ALLOWED_KEYS.forEach(function (k) {
          if (stores[k] != null) {
            __origSetItem.call(localStorage, k, JSON.stringify(stores[k]));
          }
        });
        __origSetItem.call(localStorage, SYNC_AT_KEY, remoteSyncedAt);
        sessionStorage.setItem(RELOAD_SENTINEL, remoteSyncedAt);
        setInd('busy', 'aplicando atualização…');
        // Reload pra que os scripts existentes releiam localStorage do zero.
        setTimeout(function () { location.reload(); }, 80);
        return;
      }

      // Caso 3: já estamos sincronizados (ou foi nossa última edição).
      if (remoteSyncedAt) localStorage.setItem(SYNC_AT_KEY, remoteSyncedAt);
      setInd('ok', 'sincronizado · ' + hhmm());
      startInterception();
      startPolling();
    }).catch(function () {
      setInd('off', 'offline · usando local');
      startInterception();
      startPolling();
    });
  }

  // ====== INTERCEPTAÇÃO DE SAVES ======
  var __origSetItem = Storage.prototype.setItem;
  var pendingTimers = {};
  function startInterception() {
    Storage.prototype.setItem = function (k, v) {
      __origSetItem.apply(this, arguments);
      if (this === window.localStorage && ALLOWED_KEYS.indexOf(k) !== -1) {
        scheduleSync(k);
      }
    };
  }
  function scheduleSync(key) {
    setInd('busy', 'salvando…');
    if (pendingTimers[key]) clearTimeout(pendingTimers[key]);
    pendingTimers[key] = setTimeout(function () {
      pendingTimers[key] = null;
      var raw = localStorage.getItem(key);
      var value;
      try { value = JSON.parse(raw); } catch (e) { value = raw; }
      var ifMatch = localStorage.getItem(SYNC_AT_KEY);
      apiPost(key, value, ifMatch).then(function (resp) {
        if (resp && resp.ok) {
          __origSetItem.call(localStorage, SYNC_AT_KEY, resp.lastModified);
          setInd('ok', 'sincronizado · ' + hhmm());
        } else {
          setInd('off', 'erro ao salvar · tentando depois');
          setTimeout(function () { scheduleSync(key); }, 5000);
        }
      }).catch(function () {
        setInd('off', 'offline · salvo local');
        setTimeout(function () { scheduleSync(key); }, 8000);
      });
    }, DEBOUNCE_MS);
  }

  // ====== POLLING (detecta edição de outro usuário) ======
  function startPolling() {
    setInterval(function () {
      // Não pollar se o usuário está editando algo (foco em input/textarea)
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable)) return;

      apiGet('all').then(function (resp) {
        if (!resp || !resp.ok) return;
        var remoteSyncedAt = resp.lastModified;
        var localSyncedAt = localStorage.getItem(SYNC_AT_KEY);
        if (remoteSyncedAt && remoteSyncedAt !== localSyncedAt) {
          setInd('new', '↻ nova versão de ' + (resp.lastAuthor || '?') + ' · recarregar');
          ind.onclick = function () {
            ALLOWED_KEYS.forEach(function (k) {
              if (resp.stores[k] != null) {
                __origSetItem.call(localStorage, k, JSON.stringify(resp.stores[k]));
              }
            });
            __origSetItem.call(localStorage, SYNC_AT_KEY, remoteSyncedAt);
            sessionStorage.setItem(RELOAD_SENTINEL, remoteSyncedAt);
            location.reload();
          };
        }
      }).catch(function () { /* silencioso */ });
    }, POLL_MS);
  }

  // Aguarda DOM pronto pra ter <body> onde injetar o indicador
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
