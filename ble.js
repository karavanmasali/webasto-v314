/** HeatGenie RE5011 BLE — supervised/manual diagnostics ONLY. */
import {HEATGENIE_SERVICE, HEATGENIE_READ_CHAR, HEATGENIE_WRITE_CHAR, parseHeatGenieStatus, crc16CcittZero} from './protocol.mjs?v=3.10.0';
import {guardedBuild,hexBytes} from './command-profile.mjs?v=3.10.0';
const bufferHex = data => hexBytes(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? undefined));
export const runningStep = status => status.stateCode & 0x0f;
export const isOffStep = status => [0,5].includes(runningStep(status));
export class HeatGenieBLE {
  constructor(onLog, onDisconnect, onStatus=()=>{}) {
    this.onLog=onLog;this.onDisconnect=onDisconnect;this.onStatus=onStatus;
    this.device=null;this.server=null;this.chars=[];this.writeChar=null;
    this.lastVerifiedStatus=null;this.lastStatusAt=0;
    this.connected=false;this.writePending=false;this.waiter=null;this.startTried=false;this.powerAck=null;
    this.lastStartAt=0;this.lastStartB4=null;this.repeatSeen=false;this.userDisconnect=false;this.reconnecting=false;
    this.onReconnect=()=>{};this.onGiveUp=()=>{};
  }
  process(data, source) {
    this.onLog(`${source}: ${bufferHex(data)}`);
    try {
      // HeatGenie also sends valid 8-byte *command replies* on 3A00.
      // Keep them in diagnostic traces rather than labelling them bad telemetry.
      const raw = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? undefined);
      if(raw.length===8 && raw[0]===0xAA){
        if(crc16CcittZero(raw)!==0){this.onLog('KISA YANIT: CRC HATALI — geçersiz.');return;}
        const op='0x'+raw[2].toString(16).padStart(2,'0').toUpperCase();
        const arg=hexBytes(raw.subarray(3,6));
        this.onLog(`KISA YANIT CRC OK | opcode ${op} | alanlar ${arg} | Bu yanıt tek başına START başarısı değildir.`);
        // 0x41 echoes B4 in byte4. In Dizi C B4 is the start target temperature.
        // A matching ACK alone does NOT prove real ignition.
        if (raw[2]===0x41) {
          const code=raw[3], echoedB4=raw[4];
          const label=code===0?'KOMUT KABUL YANITI':code===1?'TEKRAR KOMUT':'KOMUT BAŞARISIZ / BİLİNMEYEN';
          this.onLog(`HEATGENIE 0x41 ACK: durum=${code} (${label}), B4=${echoedB4}${this.powerAck ? ', beklenen B4='+this.powerAck.b4 : ''}.`);
          if (code===1 && this.lastStartB4!==null && echoedB4===this.lastStartB4) this.repeatSeen=true;
          if (this.powerAck && echoedB4===this.powerAck.b4) {
            this.powerAck.responseCode=code;
            this.onLog(code===0?'START B4 yanıtı eşleşti. Fiziksel ateşleme ayrıca durum adımıyla doğrulanır.':'START B4 yanıtı eşleşti fakat cihaz olumlu yanıt vermedi.');
          }
        }
        return;
      }
      if(raw.length===0){return;} // Bazı cihaz sürümleri ilk subscribe/read anında boş DataView verir.
      const status=parseHeatGenieStatus(data);
      this.lastVerifiedStatus=status;this.lastStatusAt=Date.now();
      this.onLog(`CRC OK | Oda ${status.roomTemp.toFixed(1)} °C | Kasa ${status.caseTemp.toFixed(1)} °C | Akü ${status.voltage.toFixed(1)} V | Hedef ${status.target} °C | Mod ${((status.flags>>5)&3)} | Adım ${runningStep(status)} | Kayıt34=0x${status.register34.toString(16).padStart(2,'0')} (anlamı belirsiz) | Hata 0x${status.errorFlags.toString(16)}`);
      this.onStatus(status);
      if(this.waiter && this.waiter.predicate(status)) this.completeWaiter(true);
    }catch(e){this.onLog(`Paket atlandı: ${e.message}`);}
  }
  completeWaiter(confirmed) {
    if(!this.waiter)return;
    const w=this.waiter;this.waiter=null;clearTimeout(w.timer);w.resolve(confirmed);
  }
  onLost() {
    this.connected=false;this.chars=[];this.writeChar=null;this.lastVerifiedStatus=null;this.lastStatusAt=0;this.powerAck=null;
    this.completeWaiter(false);
    if(this.reconnecting)return; // yeniden bağlanma döngüsü zaten sürüyor
    const willReconnect=!this.userDisconnect && !!this.device;
    this.onLog(willReconnect?'Bluetooth bağlantısı kesildi. Otomatik yeniden bağlanma denenecek (en çok 10 dk).':'Bluetooth bağlantısı kesildi.');
    this.onDisconnect(willReconnect);
    if(willReconnect){this.reconnecting=true;this.reconnectLoop();}
  }
  async reconnectLoop() {
    const started=Date.now();
    while(this.reconnecting && Date.now()-started<10*60*1000){
      await new Promise(r=>setTimeout(r,4000));
      if(!this.reconnecting)return;
      try{
        this.server=await this.device.gatt.connect();this.connected=true;
        await this.setupServices();
        this.reconnecting=false;this.onLog('Yeniden bağlandı.');this.onReconnect();return;
      }catch(e){
        this.connected=false;this.onLog('Yeniden bağlanma başarısız: '+e.message);
        try{this.device.gatt.disconnect();}catch{}
      }
    }
    if(this.reconnecting){this.reconnecting=false;this.onLog('Yeniden bağlanma süresi doldu.');this.onGiveUp();}
  }
  async connect() {
    if(!navigator.bluetooth)throw new Error('Web Bluetooth için Windows Chrome/Edge kullan.');
    const device=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:[HEATGENIE_SERVICE]});
    this.device=device;this.userDisconnect=false;this.reconnecting=false;
    device.addEventListener('gattserverdisconnected',()=>this.onLost());
    this.server=await device.gatt.connect();this.connected=true;
    try {
      await this.setupServices();
      return device.name||'Bluetooth cihazı';
    }catch(e){this.disconnect();throw e;}
  }
  async setupServices() {
    {
      const svc=await this.server.getPrimaryService(HEATGENIE_SERVICE);
      const chars=await svc.getCharacteristics();this.chars=chars;
      this.writeChar=chars.find(ch=>ch.uuid.toLowerCase()===HEATGENIE_WRITE_CHAR && ch.properties.write)??null;
      for(const ch of chars){
        const p=ch.properties;
        this.onLog(`Karakteristik ${ch.uuid}; read=${p.read}, notify=${p.notify}, write=${p.write}, writeNoResp=${p.writeWithoutResponse}`);
        if(ch.uuid.toLowerCase()===HEATGENIE_READ_CHAR){
          if(p.notify){
            ch.addEventListener('characteristicvaluechanged',e=>this.process(e.target.value,`BİLDİRİM ${ch.uuid}`));
            await ch.startNotifications();this.onLog('3A00 bildirimleri başlatıldı.');
          }
          if(p.read){try{this.process(await ch.readValue(),`OKUMA ${ch.uuid}`);}catch(e){this.onLog(`İlk okuma alınamadı: ${e.message}`);}}
        }
      }
      if(!this.writeChar)this.onLog('UYARI: 3A01 yazma karakteristiği yok; manuel test kilitli.');
    }
  }
  async read(){
    const ch=this.chars.find(x=>x.uuid.toLowerCase()===HEATGENIE_READ_CHAR && x.properties.read);
    if(ch){try{this.process(await ch.readValue(),`OKUMA ${ch.uuid}`);}catch(e){this.onLog(`Okuma hatası: ${e.message}`);}}
  }
  disconnect(){
    this.userDisconnect=true;this.reconnecting=false;
    if(this.device?.gatt?.connected)this.device.gatt.disconnect();
    this.connected=false;this.chars=[];this.writeChar=null;this.lastVerifiedStatus=null;this.lastStatusAt=0;this.startTried=false;this.powerAck=null;this.completeWaiter(false);
  }
  /** STOP için telemetri tazeliği veya hata bayrağı aranmaz: yalnızca bağlantı ve 3A01 yeterlidir. */
  get canStop() { return this.connected && !!this.writeChar; }
  async requestStatus() {
    if(!this.connected||!this.writeChar)return;
    try{await this.writeChar.writeValueWithResponse(guardedBuild('auto-update'));this.onLog('Salt-okunur durum isteği gönderildi (telemetri gecikti).');}
    catch(e){this.onLog('Durum isteği hatası: '+e.message);}
  }
  get canControl() {
    return this.connected && !!this.writeChar && !!this.lastVerifiedStatus &&
      Date.now()-this.lastStatusAt < 6000 && !this.writePending;
  }
  async sendCommand(operation,value){
    if(operation==='stop'){ if(!this.canStop)throw new Error('STOP için Bluetooth/3A01 bağlantısı yok.'); if(this.waiter)this.completeWaiter(false); }
    else if(!this.canControl)throw new Error('Güncel ve doğrulanmış telemetri veya 3A01 bağlantısı yok.');
    if(this.writePending && operation!=='stop')throw new Error('Önceki komut henüz tamamlanmadı.');
    if(operation!=='stop' && this.lastVerifiedStatus.errorFlags)throw new Error('Cihazda hata bayrağı var. Orijinal kontrol panelinden kontrol edin.');
    if(operation==='target' && (this.lastVerifiedStatus.flags & 0x10))throw new Error('Cihaz Fahrenheit modunda; Celsius hedef komutu göndermeyeceğiz.');
    const old=this.lastVerifiedStatus ?? {stateCode:0x0f,flags:0,target:0,register34:0,errorFlags:0}; // STOP, telemetri olmadan da gidebilir
    if(operation==='start' && !isOffStep(old))throw new Error('START için cihazın kapalı/bekleme halinde olması gerekiyor.');
    if(operation==='stop' && isOffStep(old) && Date.now()-this.lastStartAt>90000)throw new Error('STOP için cihaz zaten kapalı/bekleme durumunda görünüyor.');
    if(operation==='target' && old.target===value)throw new Error(`Cihaz zaten ${value} °C hedefte.`);
    let startTarget;
    if(operation==='start') {
      // Dizi C: B4=cihazın en son CRC-doğrulanmış 3A00 bildirimindeki hedef sıcaklık.
      // UI'daki eski hedef, otomatik ayar ya da random değer asla kullanılmaz.
      startTarget=old.target;
      if(!Number.isInteger(startTarget) || startTarget<10 || startTarget>40)
        throw new Error('START için cihazdan doğrulanmış 10–40 °C hedef değeri gerekli.');
      // DOĞRULANMAMIŞ varsayım: B4 tekrar-koruması (nonce) olabilir. Cihaz önceki START'a 'TEKRAR KOMUT' (0x41, durum=1) dediyse B4'ü ±1 kaydır.
      if(this.repeatSeen && this.lastStartB4===startTarget){startTarget=startTarget<40?startTarget+1:startTarget-1;this.onLog('Önceki START tekrar komut yanıtı aldı; bu sefer B4='+startTarget+' kullanılıyor.');}
      this.repeatSeen=false;this.lastStartB4=startTarget;this.lastStartAt=Date.now();
      this.powerAck={b4:startTarget,responseCode:null};
      this.onLog(`V3.9 DİZİ C: START B4=hedef ${startTarget} °C (0x${startTarget.toString(16).padStart(2,'0').toUpperCase()}), B5=00; CRC hesaplanıyor. Mod değiştirilmez.`);
    }
    const bytes=guardedBuild(operation,operation==='start'?startTarget:value);
    this.writePending=true;
    try {
      this.onLog(`3A01 YAZMA İSTEĞİ (${operation}${operation==='target'?' '+value+'°C':operation==='start'?' / Dizi C B4='+startTarget+'°C':''}): ${hexBytes(bytes)} | Önceki durum adımı: ${runningStep(old)} | Hedef: ${old.target}`);
      // RE5011 reports write=true, writeWithoutResponse=false. Do not force no-response.
      await this.writeChar.writeValueWithResponse(bytes);
      this.onLog(`3A01 GATT yazma yanıtı alındı (${operation}). Bu, ısıtıcının komutu UYGULADIĞINI kanıtlamaz.`);
      this.writePending=false; // doğrulama beklerken STOP engellenmesin
      let predicate;
      if(operation==='target')predicate=s=>s.target===value;
      else if(operation==='start')predicate=s=>!isOffStep(s) && !s.errorFlags;
      else predicate=s=>isOffStep(s)||runningStep(s)!==runningStep(old);
      const confirmed=await new Promise(resolve=>{
        const timer=setTimeout(()=>this.completeWaiter(false), operation==='target'?6500:16000);
        this.waiter={resolve,predicate,timer};
      });
      if(operation==='start'){
        const ack=this.powerAck;
        this.onLog(ack?.responseCode===0 ? '0x41 START ACK BAŞARILI: B4 eşleşti. Fiziksel ateşleme ancak adım değişimiyle doğrulanır.' : ack?.responseCode===1 ? '0x41 START ACK: TEKRAR KOMUT bildirildi; otomatik tekrar yok.' : ack?.responseCode!=null ? `0x41 START ACK: farklı durum kodu ${ack.responseCode}.` : '0x41 START ACK: bu gözlem penceresinde eşleşen yanıt görülmedi.');
        const now=this.lastVerifiedStatus;
        this.onLog(`START alan karşılaştırması: kayıt34 0x${old.register34.toString(16).padStart(2,'0')} → 0x${(now?.register34 ?? old.register34).toString(16).padStart(2,'0')}; adım ${runningStep(old)} → ${now?runningStep(now):'bilinmiyor'}. Kayıt34 anlamı kesin değil, ateşleme kanıtı değildir.`);
      }
      if(confirmed){
        this.onLog(operation==='target' ? `CİHAZ HEDEF OKUMASI DOĞRULANDI: ${value} °C` : `CİHAZ DURUM DEĞİŞİMİ GÖRÜLDÜ (${operation}); ateşleme/soğutmanın tamamlandığı anlamına gelmez.`);
      }else this.onLog(`CİHAZ ETKİSİ DOĞRULANAMADI (${operation}). Aynı komutu otomatik tekrarlama.`);
      return {transportAccepted:true,confirmed,kind:operation==='target'?'target':'transition'};
    }catch(e){this.onLog(`3A01 komut hatası (${operation}): ${e.message}`);throw e;}
    finally{this.writePending=false;}
  }
  /** Controller reports HeatGenie run mode in high bits of flags register. */
  get runMode(){
    return this.lastVerifiedStatus ? ((this.lastVerifiedStatus.flags >> 5) & 3) : null;
  }
  async waitForStatus(predicate, durationMs){
    if(this.lastVerifiedStatus && predicate(this.lastVerifiedStatus))return true;
    return new Promise(resolve=>{
      const timer=setTimeout(()=>this.completeWaiter(false),durationMs);
      this.waiter={resolve,predicate,timer};
    });
  }
  async writeMode(value){
    if(!this.canControl)throw new Error('Mod işlemi için BLE telemetrisi güncel değil.');
    if(this.lastVerifiedStatus.errorFlags)throw new Error('Cihaz hata bildiriyor. Mod değiştirilmedi.');
    if(!isOffStep(this.lastVerifiedStatus) || this.lastVerifiedStatus.fan || this.lastVerifiedStatus.pump || this.lastVerifiedStatus.glow)
      throw new Error('Mod değişikliği yalnızca tamamen durmuş ısıtıcıda denenir.');
    const oldMode=this.runMode;
    if(oldMode===value){this.onLog('Mod zaten '+value+'. Yazma gerekmedi.');return true;}
    const beforeAt=this.lastStatusAt;
    if(![0,1,2].includes(value))throw new Error('Yalnızca mod 0/1/2 desteklenir.');
    const modeOperation={0:'constant-mode',1:'manual-gear-mode',2:'start-stop-mode'}[value];
    const bytes=guardedBuild(modeOperation);
    this.onLog(`MOD ${oldMode} → ${value} yazılıyor (0x66): ${hexBytes(bytes)} | Adım=${runningStep(this.lastVerifiedStatus)}`);
    this.writePending=true;
    try {
      await this.writeChar.writeValueWithResponse(bytes);
      this.onLog('MOD GATT yazma yanıtı geldi. Cihazın yeni modunu bekliyorum.');
      // A response can arrive during the await; only a NEW status confirms it.
      const current=this.lastVerifiedStatus;
      const already=this.lastStatusAt>beforeAt && current && (((current.flags>>5)&3)===value);
      const confirmed=already || await this.waitForStatus(s=>((s.flags>>5)&3)===value,9000);
      this.onLog(`MOD ${value} SONUÇ: ${confirmed?'3A00 cihaz kaydından doğrulandı.':'DOĞRULANMADI. START GÖNDERİLMEYECEK.'}`);
      return confirmed;
    } finally {this.writePending=false;}
  }
  /** V3.9: User-confirmed Dizi C from the standalone RE5011 test tool.
   * START only when off, in MODE 0, with fresh CRC-verified temperature.
   * Sends 0x61 0x01 <device target 10..40> 0x00, one time.
   */
  async startWithTemperatureB4(){
    if(Date.now()-this.lastStartAt<60000)throw new Error('Son START 60 sn içinde gönderildi; tekrar START bekletiliyor.');
    if(!this.canControl)throw new Error('START için güncel BLE telemetrisi gerekli.');
    const initial=this.lastVerifiedStatus;
    if(initial.errorFlags)throw new Error('Cihaz hata bildiriyor; START gönderilmiyor.');
    if(!isOffStep(initial) || initial.fan || initial.pump || initial.glow)
      throw new Error('START yalnızca cihaz tamamen durmuşken denenebilir.');
    if(this.runMode!==0)throw new Error(`Cihaz MOD ${this.runMode}. Önce tamamen durmuş cihazı “Otomatik/Sıcaklık moduna dön (0)” ile MOD 0 yap.`);
    this.onLog('V3.9: Kullanıcının çalıştırdığı Dizi C seçildi. MOD 0 korunur; güncel hedef B4 ile TEK 0x61 START gönderilir.');
    return this.sendCommand('start');
  }
  async restoreTemperatureMode(){
    this.onLog('V3.9: Kullanıcı isteğiyle çalışma modu 0 (sıcaklık) geri seçiliyor.');
    return this.writeMode(0);
  }
  async start(){return this.startWithTemperatureB4();}
  async stop(){return this.sendCommand('stop');}
  async target(degrees){return this.sendCommand('target',degrees);}
}
