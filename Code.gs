/**
 * Backend de sincronização do painel Projeto Neon · LPNCC
 *
 * Guarda dois "stores" no PropertiesService (Document/Script scope):
 *   - projeto_neon_lpncc  → estado principal (checks, status, resp, fields, stamps, author, custom_tasks, etc)
 *   - neon_cc_fat         → array dos 15 faturamentos do cálculo de contrato
 *
 * Endpoints:
 *   GET  ?key=projeto_neon_lpncc           → { ok, key, value, lastModified, lastAuthor }
 *   GET  ?key=all                          → { ok, stores: {...}, lastModified, lastAuthor }
 *   POST { key, value, author, ifMatch? }  → grava; ifMatch é ISO de lastModified que o cliente viu por último
 *                                            (não bloqueia, só informa se sobrescreveu mais novo)
 *
 * CORS: respondemos sempre em text/plain com JSON dentro pra evitar preflight.
 * O cliente faz fetch com Content-Type: text/plain;charset=utf-8.
 *
 * Limites: PropertiesService permite 9KB por valor. Se o estado crescer além disso,
 * particionar em chaves (ex.: projeto_neon_lpncc__checks, __fields, __stamps...) e
 * reagregar no GET. Hoje cabe folgado.
 */

var ALLOWED_KEYS = ['projeto_neon_lpncc', 'neon_cc_fat'];
var META_KEY = '__meta';

function _props() {
  // ScriptProperties = compartilhado entre todos os usuários do script
  return PropertiesService.getScriptProperties();
}

function _readMeta() {
  var raw = _props().getProperty(META_KEY);
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function _writeMeta(meta) {
  _props().setProperty(META_KEY, JSON.stringify(meta));
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _readStore(key) {
  var raw = _props().getProperty(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function _writeStore(key, value) {
  _props().setProperty(key, JSON.stringify(value));
}

function doGet(e) {
  try {
    var key = (e && e.parameter && e.parameter.key) || 'all';
    var meta = _readMeta();

    if (key === 'all') {
      var stores = {};
      ALLOWED_KEYS.forEach(function (k) { stores[k] = _readStore(k); });
      return _json({
        ok: true,
        stores: stores,
        lastModified: meta.lastModified || null,
        lastAuthor: meta.lastAuthor || null
      });
    }

    if (ALLOWED_KEYS.indexOf(key) === -1) {
      return _json({ ok: false, error: 'key não permitida' });
    }

    return _json({
      ok: true,
      key: key,
      value: _readStore(key),
      lastModified: meta.lastModified || null,
      lastAuthor: meta.lastAuthor || null
    });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    // O cliente envia JSON no body (Content-Type: text/plain pra evitar preflight CORS).
    var body = JSON.parse(e.postData.contents);
    var key = body.key;
    var value = body.value;
    var author = body.author || 'desconhecido';
    var ifMatch = body.ifMatch || null;

    if (ALLOWED_KEYS.indexOf(key) === -1) {
      return _json({ ok: false, error: 'key não permitida' });
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(8000); // até 8s pra evitar perda em writes concorrentes
    try {
      var meta = _readMeta();
      var overwroteNewer = false;
      if (ifMatch && meta.lastModified && ifMatch !== meta.lastModified) {
        // Cliente está sobrescrevendo um estado mais novo que ele não viu.
        // Last-write-wins, mas informamos pro cliente exibir aviso se quiser.
        overwroteNewer = true;
      }
      _writeStore(key, value);
      var nowIso = new Date().toISOString();
      meta.lastModified = nowIso;
      meta.lastAuthor = author;
      _writeMeta(meta);

      return _json({
        ok: true,
        key: key,
        lastModified: nowIso,
        lastAuthor: author,
        overwroteNewer: overwroteNewer
      });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

/**
 * Util manual (rodar uma vez no editor pra confirmar que tudo está vazio/saudável).
 */
function debug_dump() {
  var meta = _readMeta();
  var out = { _meta: meta };
  ALLOWED_KEYS.forEach(function (k) { out[k] = _readStore(k); });
  Logger.log(JSON.stringify(out, null, 2));
}

/**
 * Util manual: limpa tudo (use com cuidado, só em desenvolvimento).
 */
function debug_reset() {
  _props().deleteAllProperties();
  Logger.log('Properties zeradas.');
}
