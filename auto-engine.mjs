/** V3.9 gerçek cihaz otomatik termostat motoru. iOS uygulamasındaki ThermostatEngine ile aynı mantık.
 *  Zamanlayıcı kullanmaz: yalnızca yeni durum paketi geldiğinde çağrılır, beklemeler zaman damgasıyla hesaplanır. */
export class AutoEngine {
  constructor() {
    this.cfg = {auto:false, start:20, stop:25, stopDelay:30, restartDelay:180, maxStartsPerHour:4};
    this.startHistory = [];
    this.lastStopSentAt = null;
    this.lastStartSentAt = null;
    this.reset();
  }
  reset() {
    this.stopSince = null; this.awaitingOff = false; this.awaitingRun = false;
    this.stopRetries = 0; this.failedStarts = 0; this.stopAlerted = false; this.limitAlerted = false;
    this.stepAtStop = null; this.stopTookEffect = false;
  }
  /** Komut gerçekte gönderilemediyse çağrılır; motor "gönderildi" varsaymasın. */
  sendFailed(action) {
    if (action === 'stop') { this.awaitingOff = false; this.stopSince = null; this.lastStopSentAt = null; }
    else if (action === 'start') { this.awaitingRun = false; this.lastStartSentAt = null; this.startHistory.pop(); }
  }
  evaluate(s, now) {
    const cfg = this.cfg, f1 = v => v.toFixed(1);
    const D = (reason, extra = {}) => ({action:'none', reason, alert:null, disableAuto:false, ...extra});
    if (!cfg.auto) { this.reset(); return D('Otomatik kapalı'); }
    if (s.errorFlags) return D('Cihaz hata bildiriyor', {alert:`Webasto hata bayrağı 0x${s.errorFlags.toString(16).toUpperCase()}. Otomatik kontrol kapatıldı, cihazı kontrol edin.`, disableAuto:true});
    if (s.flags & 0x10) return D('Cihaz Fahrenheit modunda', {alert:'Cihaz Fahrenheit modunda; otomatik kontrol kapatıldı.', disableAuto:true});

    const step = s.stateCode & 0x0f, room = s.roomTemp, mode = (s.flags >> 5) & 3;
    const idle = (step === 0 || step === 5) && !s.fan && !s.pump && !s.glow;

    if (idle) {
      this.stopSince = null; this.awaitingOff = false; this.stopRetries = 0; this.stopAlerted = false;
      if (this.awaitingRun && this.lastStartSentAt != null) {
        if (now - this.lastStartSentAt < 90000) return D('Ateşleme başlaması bekleniyor');
        this.awaitingRun = false; this.failedStarts++;
        if (this.failedStarts >= 2) return D('START iki kez etkisiz kaldı', {alert:'START iki kez denendi ama ısıtıcı çalışmadı. Otomatik kontrol kapatıldı.', disableAuto:true});
      }
      if (mode !== 0) return D(`Cihaz Mod ${mode}; START için Mod 0 gerekli`);
      for (const t of [this.lastStopSentAt, this.lastStartSentAt]) {
        if (t != null) { const left = cfg.restartDelay * 1000 - (now - t); if (left > 0) return D(`Yeniden başlatma beklemesi: ${Math.ceil(left/1000)} sn`); }
      }
      this.startHistory = this.startHistory.filter(t => now - t <= 3600000);
      if (this.startHistory.length >= cfg.maxStartsPerHour) {
        const d = D(`Saatlik START sınırına ulaşıldı (${cfg.maxStartsPerHour})`);
        if (!this.limitAlerted) { this.limitAlerted = true; d.alert = 'Saatlik START sınırına ulaşıldı. Sık açılıp kapanma varsa START/STOP aralığını açın.'; }
        return d;
      }
      if (room <= cfg.start) {
        this.startHistory.push(now); this.lastStartSentAt = now; this.awaitingRun = true;
        return D(`Oda ${f1(room)} °C ≤ ${cfg.start} °C: START`, {action:'start'});
      }
      return D(`Kapalı · START için ≤ ${cfg.start} °C bekleniyor (oda ${f1(room)})`);
    }

    // Çalışıyor / geçiş
    this.awaitingRun = false; this.failedStarts = 0; this.limitAlerted = false;
    if (this.awaitingOff) {
      if (this.stepAtStop != null && step !== this.stepAtStop) this.stopTookEffect = true;
      if (this.stopTookEffect) return D('STOP uygulandı, soğutma bekleniyor');
      if (this.lastStopSentAt != null && now - this.lastStopSentAt >= 60000) {
        if (this.stopRetries < 3) { this.stopRetries++; this.lastStopSentAt = now; return D(`STOP etkisiz, tekrar (${this.stopRetries}/3)`, {action:'stop'}); }
        const d = D('STOP etkisiz');
        if (!this.stopAlerted) { this.stopAlerted = true; d.alert = 'STOP komutu 3 kez gönderildi ama ısıtıcı durmadı. Cihazı elle durdurun!'; }
        return d;
      }
      return D('STOP gönderildi, yanıt bekleniyor');
    }
    if (room >= cfg.stop) {
      const since = this.stopSince ?? now; this.stopSince = since;
      const waited = now - since;
      if (waited >= cfg.stopDelay * 1000) {
        this.stopSince = null; this.awaitingOff = true; this.stopRetries = 0; this.stopAlerted = false;
        this.stopTookEffect = false; this.stepAtStop = step; this.lastStopSentAt = now;
        return D(`Oda ${f1(room)} °C ≥ ${cfg.stop} °C: STOP`, {action:'stop'});
      }
      return D(`STOP geri sayımı: ${Math.ceil(cfg.stopDelay - waited/1000)} sn`);
    }
    this.stopSince = null;
    return D(`Çalışıyor · STOP için ≥ ${cfg.stop} °C bekleniyor (oda ${f1(room)})`);
  }
}
