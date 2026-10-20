/** V3 kontrol hesabı: ısıtıcıya ulaşım katmanından bağımsız, test edilebilir. */
export const MIN_GAP = 2;
export const LIMITS = Object.freeze({ startMin: 10, startMax: 38, stopMin: 12, stopMax: 40, targetMin: 10, targetMax: 40 });
export const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
/** Eşikler bağımsızdır; sadece 2°C sınırına temas edilirse karşı eşik de kayar. */
export function changeStart(cfg, delta) {
  const next = {...cfg};
  next.start = clamp(cfg.start + delta, LIMITS.startMin, LIMITS.startMax);
  // 19/21 → START+ → 20/22; geniş farkta STOP sabit kalır.
  next.stop = clamp(Math.max(cfg.stop, next.start + MIN_GAP), LIMITS.stopMin, LIMITS.stopMax);
  if (next.auto) next.target = next.stop;
  return next;
}
export function changeStop(cfg, delta) {
  const next = {...cfg};
  next.stop = clamp(cfg.stop + delta, LIMITS.stopMin, LIMITS.stopMax);
  // 19/21 → STOP- → 18/20; geniş farkta START sabit kalır.
  next.start = clamp(Math.min(cfg.start, next.stop - MIN_GAP), LIMITS.startMin, LIMITS.startMax);
  if (next.auto) next.target = next.stop;
  return next;
}
export function updateAuto(cfg, enabled) {
  return {...cfg, auto: !!enabled, target: enabled ? cfg.stop : cfg.target};
}
export function safeConfig(raw) {
  const cfg = {start: 20, stop: 25, target: 25, auto: false, stopDelay: 20, restartDelay: 120};
  if (raw && typeof raw === 'object') {
    if (Number.isFinite(raw.start)) cfg.start = clamp(Math.round(raw.start), LIMITS.startMin, LIMITS.startMax);
    if (Number.isFinite(raw.stop)) cfg.stop = clamp(Math.round(raw.stop), cfg.start + MIN_GAP, LIMITS.stopMax);
    if (Number.isFinite(raw.target)) cfg.target = clamp(Math.round(raw.target), LIMITS.targetMin, LIMITS.targetMax);
    if ([10,20,30,60].includes(raw.stopDelay)) cfg.stopDelay = raw.stopDelay;
    if ([120,180,300,600].includes(raw.restartDelay)) cfg.restartDelay = raw.restartDelay;
    // Tercih saklanır; fiziksel kontrol her yeni oturumda ayrıca etkinleştirilir.
    cfg.auto = raw.auto === true;
  }
  return cfg;
}
/** Çağrı yalnızca doğrulanmış, taze veri ve gerçek adaptörde yapılmalı. */
export function thermostatDecision({cfg, state, now, running, room, isFresh, stopSince, lastStoppedAt, error}) {
  if (!cfg.auto || !isFresh || error || !Number.isFinite(room) || !['on','off','starting','stopping'].includes(running))
    return {command: null, stopSince: null, reason: !cfg.auto ? 'Otomatik mod kapalı' : 'Güncel ve doğrulanmış ısıtıcı verisi bekleniyor'};
  if (running === 'starting' || running === 'stopping') return {command:null, stopSince:null, reason:'Isıtıcının geçiş işlemi bekleniyor'};
  if (running === 'on') {
    if (room < cfg.stop) return {command:null, stopSince:null, reason:`STOP için ${cfg.stop} °C bekleniyor`};
    const since = stopSince ?? now;
    if (now - since >= cfg.stopDelay * 1000) return {command:'stop',stopSince:null,reason:'STOP sıcaklığı yeterince korundu'};
    return {command:null,stopSince:since,reason:`STOP geri sayımı: ${Math.max(0,Math.ceil(cfg.stopDelay-(now-since)/1000))} sn`};
  }
  if (lastStoppedAt && now - lastStoppedAt < cfg.restartDelay * 1000)
    return {command:null,stopSince:null,reason:`Yeniden başlatma beklemesi: ${Math.ceil((cfg.restartDelay*1000 - (now-lastStoppedAt))/1000)} sn`};
  if (room <= cfg.start) return {command:'start',stopSince:null,reason:'START eşiğine ulaşıldı'};
  return {command:null,stopSince:null,reason:`START için ${cfg.start} °C bekleniyor`};
}
