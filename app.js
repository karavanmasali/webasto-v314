import {changeStart,changeStop,updateAuto,safeConfig,clamp} from './thermostat.mjs?v=3.14.0';
import {HeatGenieBLE} from './ble.js?v=3.10.0';
import {AutoEngine} from './auto-engine.mjs?v=3.10.0';
import {normalizeHistory,addHistory,dayStats,historyCsv,recordedRuntimeMs,normalizeTemperatures,addTemperature} from './activity-log.mjs?v=3.10.0';
const $=id=>document.getElementById(id);
const MANUAL_TARGET_KEY='webasto-v313-manual-target';
const CONFIG_KEY='webasto-v3',HISTORY_KEY='webasto-v310-history',OPTIONS_KEY='webasto-v310-options',TEMP_KEY='webasto-v310-temperatures',LAST_STOP_KEY='webasto-last-auto-stop';
const getJSON=(k,defaultValue)=>{try{return JSON.parse(localStorage.getItem(k))??defaultValue;}catch{return defaultValue;}};
let cfg=safeConfig(getJSON(CONFIG_KEY,null));
// Manuel hedef, otomatik STOP değerinden tamamen bağımsız tutulur.
const storedManualTarget=getJSON(MANUAL_TARGET_KEY,null);
let manualTarget=Number.isFinite(storedManualTarget)
 ? clamp(Math.round(storedManualTarget),10,40)
 : clamp(Number.isFinite(cfg.target)?Math.round(cfg.target):23,10,40);
let manualHint='';
let manualSyncTimer=null;
let history=normalizeHistory(getJSON(HISTORY_KEY,[])).filter(e=>!/demo|simülasyon/i.test(e.message));
localStorage.setItem(HISTORY_KEY,JSON.stringify(history));
let temperatureHistory=normalizeTemperatures(getJSON(TEMP_KEY,[]));
let options={silent:false,night:false,...getJSON(OPTIONS_KEY,{})};
let mode='none'; // none, ble
// Açık otomatik tercih daha önce kullanıcı tarafından onaylanıp kaydedilmiştir.
// Bağlantı kesilince bu tercih değişmez; cihazdan taze telemetri yoksa komut gönderilmez.
let autoActive=cfg.auto, autoFault='',busy=false;
let room=null, targetOnDevice=null,caseTemp=null, voltage=null, fan=null,pump=null,glow=null,state=null,errorFlags=null;
let lastUpdate=0, lastStoppedAt=null,stopSince=null,logs=[],lastReason='';
let wakeLock=null,targetSyncTries=0,lastTargetSentAt=0;
const engine=new AutoEngine();
const persistedStop=Number(localStorage.getItem(LAST_STOP_KEY));
if(Number.isFinite(persistedStop)&&persistedStop>0 && Date.now()-persistedStop<10*60*1000) engine.lastStopSentAt=persistedStop;
const save=()=>localStorage.setItem(CONFIG_KEY,JSON.stringify(cfg));
const saveOptions=()=>localStorage.setItem(OPTIONS_KEY,JSON.stringify(options));
const saveHistory=()=>localStorage.setItem(HISTORY_KEY,JSON.stringify(history));
function recordTemperature(kind,value){
 const next=addTemperature(temperatureHistory,kind,value);
 if(next!==temperatureHistory){temperatureHistory=next;localStorage.setItem(TEMP_KEY,JSON.stringify(temperatureHistory));renderChart();}
}
const time=at=>new Date(at).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'});
function log(msg){logs.push(`[${new Date().toLocaleTimeString('tr-TR')}] ${msg}`);logs=logs.slice(-260);$('logOutput').textContent=logs.join('\n');}
function activity(type,message){history=addHistory(history,type,message);saveHistory();renderHistory();}
function renderHistory(){
 const stats=dayStats(history);$('todayStarts').textContent=stats.starts;$('todayStops').textContent=stats.stops;
 $('historyCount').textContent=`${history.length} kayıt`;

 const last=history.slice().reverse().find(e=>e.type==='start'||e.type==='stop');
 $('homeLastAction').textContent=last?`${time(last.at)} · ${last.type==='start'?'START':'STOP'}`:'Henüz işlem yok';
 const runtime=recordedRuntimeMs(history);$('todayRuntime').textContent=runtime?Math.round(runtime/60000)+' dk':'—';
 const list=$('historyList');list.replaceChildren();
 if(!history.length){const li=document.createElement('li');li.className='empty';li.textContent='Henüz çalışma kaydı yok.';list.append(li);return;}
 for(const e of history.slice(-12).reverse()){
   const li=document.createElement('li');li.className=`event event-${e.type}`;
   const symbol=document.createElement('span');symbol.className='event-symbol';symbol.textContent=e.type==='start'?'▶':e.type==='stop'?'■':e.type==='warning'?'!':'·';
   const main=document.createElement('div');main.className='event-content';
   const msg=document.createElement('strong');msg.textContent=e.message;
   const when=document.createElement('small');when.textContent=new Date(e.at).toLocaleDateString('tr-TR')+' · '+time(e.at);
   main.append(msg,when);li.append(symbol,main);list.append(li);
 }
}
function renderChart(){
 const now=Date.now();
 const points=temperatureHistory.filter(e=>e.mode==='ble'&&e.at>=now-86400000).sort((a,b)=>a.at-b.at);
 $('chartCount').textContent=`${points.length} ölçüm`;
 const container=$('temperatureChart');container.replaceChildren();
 if(points.length<2){const note=document.createElement('p');note.className='chart-empty';note.textContent='Grafik için en az iki sıcaklık ölçümü gerekli.';container.append(note);return;}
 const SVG='http://www.w3.org/2000/svg',create=(tag,attrs,text)=>{const e=document.createElementNS(SVG,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));if(text!==undefined)e.textContent=text;return e;};
 const svg=create('svg',{viewBox:'0 0 640 174',preserveAspectRatio:'none','aria-hidden':'true'});
 let lo=Math.min(...points.map(e=>e.value))-1,hi=Math.max(...points.map(e=>e.value))+1;
 if(hi-lo<4){const middle=(lo+hi)/2;lo=middle-2;hi=middle+2;}
 const left=56,right=625,top=21,bottom=139;const t0=now-86400000;
 const x=p=>left+(right-left)*(p.at-t0)/86400000,y=p=>bottom-(p.value-lo)/(hi-lo)*(bottom-top);
 for(let i=0;i<=3;i++){const h=top+i*(bottom-top)/3;svg.append(create('line',{x1:left,x2:right,y1:h,y2:h,stroke:'#354a67','stroke-width':1,'stroke-dasharray':'3 6'}));}
 const linePoints=points.map(p=>`${x(p).toFixed(2)},${y(p).toFixed(2)}`).join(' ');
 svg.append(create('polyline',{points:linePoints,fill:'none',stroke:'#79bcff','stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round'}));
 for(const [v,yy] of [[hi,top+5],[lo,bottom]])svg.append(create('text',{x:3,y:yy,fill:'#93b4d5','font-size':15},v.toFixed(1)+'°'));
 svg.append(create('text',{x:left,y:166,fill:'#93b4d5','font-size':13},'24 saat önce'));
 svg.append(create('text',{x:right,y:166,fill:'#93b4d5','font-size':13,'text-anchor':'end'},'Şimdi'));
 container.append(svg);
}
function silentNotice(title,body){
 if(!options.silent || !('Notification' in window) || Notification.permission!=='granted')return;
 try {new Notification(title,{body,silent:true,tag:'webasto-'+Date.now()});}catch(e){log('Bildirim gönderilemedi: '+e.message);}
}
function warning(msg){log('UYARI: '+msg);activity('warning',msg);silentNotice('Webasto uyarısı',msg);}
function pauseAuto(reason){
  // Sadece cihaz hatası / güvenlik sorunu kontrolü kilitler; tercihi silmez.
  autoActive=false;autoFault=reason;engine.reset();releaseWake();lastReason=reason;
  log('GÜVENLİK DURAKLATMASI: '+reason);render();
}
const ble=new HeatGenieBLE(log,
  (willReconnect)=>{
    lastUpdate=0;engine.reset();targetSyncTries=0;
    // Bağlantı kaybı kullanıcı tercihini veya yetkilendirilmiş otomatik kontrolü kapatmaz.
    if(cfg.auto){
      activity('info','Bluetooth bağlantısı kesildi · otomatik tercih korunuyor');
      log('Bağlantı koptu; otomatik mod AÇIK olarak saklanıyor, veri yokken komut gönderilmiyor.');
    }
    if(!willReconnect){mode='none';releaseWake();}
    render();
  },
  s=>{
    room=s.roomTemp;caseTemp=s.caseTemp;voltage=s.voltage;targetOnDevice=s.target;
    fan=s.fan;pump=s.pump;glow=s.glow;state=s.stateCode;errorFlags=s.errorFlags;lastUpdate=Date.now();
    recordTemperature('ble',s.roomTemp);render();autoStep(s);
  }
);
ble.onReconnect=()=>{
  log('Bluetooth yeniden bağlandı; kayıtlı otomatik mod '+(cfg.auto?'AÇIK':'KAPALI')+'. Güncel CRC-doğrulanmış veriyle devam edilecek.');
  activity('info','Bluetooth bağlantısı yeniden kuruldu'+(cfg.auto?' · otomatik mod korunuyor':''));
  if(cfg.auto&&autoActive){lastReason='Bağlantı geri geldi; Webasto durumu doğrulanıyor.';requestWake();}
  render();
};
ble.onGiveUp=()=>{
  mode='none';engine.reset();releaseWake();
  if(cfg.auto)warning('Bluetooth yeniden bağlanamadı; otomatik ayar korunuyor ama cihaz kontrol edilmiyor.');
  render();
};
const fresh=()=>mode==='ble'&&ble.connected&&Date.now()-lastUpdate<20000;
const canControl=()=>mode==='ble'&&ble.canControl&&fresh();
const isOff=()=>state!==null&&[0,5].includes(state&0x0f)&&!fan&&!pump&&!glow;
const runningLabel=()=>{
 if(mode!=='ble'||!ble.connected)return 'Bağlantı yok';
 if(!fresh())return 'Veri bekleniyor';
 if(errorFlags)return 'Cihaz hatası';
 if(isOff())return 'Kapalı / Bekleme';
 if(glow)return 'Ateşleme';
 if(fan||pump)return 'Çalışıyor / Geçiş';
 return 'Durum kontrol ediliyor';
};
function autoStatus(){
 if(!cfg.auto)return ['Kapalı','','off'];
 if(!autoActive)return ['Güvenlik duraklatması',autoFault||'Cihaz kontrol edilene kadar otomatik komut gönderilmiyor.','waiting'];
 if(mode!=='ble'||!ble.connected||!fresh())return ['Bağlantı bekleniyor','','waiting'];
 return ['Aktif',lastReason||'Sıcaklık izleniyor','active'];
}
function render(){
 $('startValue').textContent=cfg.start+'°C';$('stopValue').textContent=cfg.stop+'°C';
 $('manualTargetValue').textContent=manualTarget+'°C';
 $('manualMinus').disabled=busy||manualTarget<=10; $('manualPlus').disabled=busy||manualTarget>=40;
 // Manuel hedef açıklaması yalnızca gerekli olduğunda gösterilir.
 $('manualTargetHint').textContent=cfg.auto?'':manualHint;
 $('autoToggle').checked=cfg.auto;$('stopDelay').value=cfg.stopDelay;$('restartDelay').value=cfg.restartDelay;
 $('silentToggle').checked=options.silent;$('nightToggle').checked=options.night;document.body.classList.toggle('night',options.night);
 const attached=mode==='ble'&&ble.connected;
 $('connectionBadge').textContent=attached?'Bağlı':mode==='ble'&&ble.reconnecting?'Bağlanıyor':'Bağlı değil';
 $('connectionBadge').className='pill '+(attached?'on':'offline');
 $('connectionMessage').textContent=attached?'Webasto bağlı':mode==='ble'&&ble.reconnecting?'Yeniden bağlanıyor':'Webasto bağlantısı bekleniyor';
 $('deviceName').textContent=attached?(ble.device?.name||'RE5011'):'';
 $('connectBtn').disabled=mode==='ble'||busy;$('disconnectBtn').disabled=mode!=='ble';
 $('roomTemp').textContent=attached&&fresh()&&room!==null?room.toFixed(1):'—';
 $('physicalTarget').textContent=attached&&fresh()&&targetOnDevice!==null?targetOnDevice:'—';
 $('voltage').textContent=attached&&fresh()&&voltage!==null?voltage.toFixed(1):'—';
 $('caseTemp').textContent=attached&&fresh()&&caseTemp!==null?caseTemp.toFixed(1)+'°C':'—';
 $('fan').textContent=attached&&fresh()&&fan!==null?(fan?'Açık':'Kapalı'):'—';
 $('pump').textContent=attached&&fresh()&&pump!==null?`${pump?'Açık':'Kapalı'} / ${glow?'Açık':'Kapalı'}`:'—';
 $('deviceMode').textContent=attached&&fresh()&&ble.runMode!==null?'Mod '+ble.runMode:'—';
 $('heaterStatus').textContent=runningLabel();
 $('heaterDot').className='status-dot '+(attached&&fresh()&&!isOff()?'lit':'');
 const [status,reason,tone]=autoStatus();$('autoState').textContent=status;$('autoReason').textContent=reason;
 $('autoDot').className='status-dot '+tone;$('autoPanel').classList.toggle('auto-selected',cfg.auto);
 $('resumeArea').hidden=!(cfg.auto&&!autoActive&&Boolean(autoFault));
 $('resumeInfo').textContent=autoFault||'Kontrol duraklatıldı.';
 $('resumeBtn').disabled=mode!=='ble'||!ble.connected||!fresh()||busy||Boolean(errorFlags);
 $('startBtn').disabled=!canControl()||busy||!isOff()||ble.runMode!==0||Date.now()-ble.lastStartAt<60000;
 $('stopBtn').disabled=mode!=='ble'||!ble.canStop||(state!==null&&isOff()&&Date.now()-ble.lastStartAt>90000);
 $('readBtn').disabled=mode!=='ble'||!ble.connected;
 $('restoreModeBtn').disabled=!canControl()||busy||ble.runMode===0||!isOff();
 $('freshness').textContent=attached?(fresh()?'Güncel':'Veri bekleniyor'):'Bağlı değil';
}
async function requestWake(){try{if(navigator.wakeLock&&!wakeLock){wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>wakeLock=null);}}catch(e){log('Ekran uyku kilidi alınamadı: '+e.message);}}
function releaseWake(){try{wakeLock?.release();}catch{}wakeLock=null;}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&autoActive&&mode==='ble')requestWake();});
function switchAutoPreference(enabled){
 cfg=updateAuto(cfg,enabled);save();
 if(!enabled){
   autoActive=false;autoFault='';lastReason='';engine.reset();stopSince=null;releaseWake();
   log('Otomatik termostat kullanıcı tarafından KAPATILDI.');activity('info','Otomatik termostat kullanıcı tarafından kapatıldı');
 }else{
   autoActive=true;autoFault='';lastReason='İlk güncel cihaz verisi bekleniyor.';engine.reset();targetSyncTries=0;
   log('Otomatik termostat kullanıcı onayıyla AÇIK olarak kaydedildi.');
   activity('info','Otomatik termostat etkinleştirildi');
   if(mode==='ble'&&ble.connected)requestWake();
 }
 render();
}
$('autoToggle').onchange=e=>{
 const enabled=e.target.checked;
 if(!enabled){switchAutoPreference(false);return;}
 // Açma onayı yalnızca otomatik mod KAPALI → AÇIK yapılırken alınır.
 const approved=window.confirm(`OTOMATİK TERMOSTATI AÇ: Ortam ${cfg.start}°C veya altına düşerse START; ${cfg.stop}°C veya üzerine çıkarsa STOP gönderebilir. Bağlantı koptuğunda ayar açık kalacak ve geri bağlandığında yeniden onay istemeden çalışmaya devam edecek. Güvenli ortam, havalandırma ve CO alarmı hazır mı?`);
 if(!approved){render();return;}
 switchAutoPreference(true);
 // Taze ve doğrulanmış paket gelir gelmez karar verilir; sadece onaydan komut çıkarılmaz.
};
$('resumeBtn').onclick=()=>{
 if(!cfg.auto||mode!=='ble'||!ble.connected||!fresh()||errorFlags)return;
 if(!window.confirm('Güvenlik duraklatması kaldırılacak. Cihazı, egzozu ve hata durumunu kontrol ettiğine emin misin?'))return;
 autoActive=true;autoFault='';engine.reset();targetSyncTries=0;lastReason='Güncel cihaz paketi bekleniyor.';
 activity('info','Güvenlik duraklatması kullanıcı tarafından kaldırıldı');requestWake();render();
};
function changeSetting(fn){
 const oldStop=cfg.stop;
 cfg=fn(cfg);save();stopSince=null;lastReason='';
 // START+ bazen STOP'u da kaydırır; otomatik cihaz hedefini yeni STOP'a eşitle.
 if(cfg.stop!==oldStop && cfg.auto)targetSyncTries=0;
 render();
}
$('startMinus').onclick=()=>changeSetting(c=>changeStart(c,-1));
$('startPlus').onclick=()=>changeSetting(c=>changeStart(c,1));
$('stopMinus').onclick=()=>changeSetting(c=>changeStop(c,-1));
$('stopPlus').onclick=()=>changeSetting(c=>changeStop(c,1));
$('stopDelay').onchange=e=>changeSetting(c=>({...c,stopDelay:Number(e.target.value)}));
$('restartDelay').onchange=e=>changeSetting(c=>({...c,restartDelay:Number(e.target.value)}));

// Manuel +/-: belleğe hemen yaz, cihaz bağlı ve manuel moddaysa kısa beklemeyle uygula.
// Her tık için ayrı BLE yazması yapmak yerine son seçilen derece gönderilir.
function setManualTarget(delta){
 const wanted=clamp(manualTarget+delta,10,40);
 if(wanted===manualTarget)return;
 manualTarget=wanted;
 localStorage.setItem(MANUAL_TARGET_KEY,JSON.stringify(manualTarget));
 manualHint='Hedef kaydedildi';
 clearTimeout(manualSyncTimer);
 if(mode==='ble'&&!cfg.auto)manualSyncTimer=setTimeout(syncManualTarget,650);
 render();
}
$('manualMinus').onclick=()=>setManualTarget(-1);
$('manualPlus').onclick=()=>setManualTarget(1);

async function syncManualTarget(){
 manualSyncTimer=null;
 if(cfg.auto||mode!=='ble'||!ble.connected)return;
 if(busy){manualSyncTimer=setTimeout(syncManualTarget,750);return;}
 if(!canControl()){
   manualHint='Ayar kaydedildi; güncel cihaz verisi gelince veya manuel START ile uygulanacak.';
   render();return;
 }
 const wanted=manualTarget;
 if(ble.lastVerifiedStatus?.target===wanted){
   manualHint=`Webasto hedefi ${wanted}°C olarak doğrulandı.`;render();return;
 }
 busy=true;manualHint=`Webasto hedefi ${wanted}°C yapılıyor…`;render();
 try{
   const result=await ble.target(wanted);
   if(result?.confirmed){cfg.target=wanted;save();manualHint=`Webasto hedefi ${wanted}°C olarak doğrulandı.`;}
   else {manualHint='Komut gönderildi fakat cihaz hedefi doğrulanmadı. START öncesi tekrar kontrol edilecek.';log('Manuel hedef değişimi doğrulanmadı.');}
 }catch(e){manualHint='Manuel hedef cihaza gönderilemedi. START öncesinde tekrar denenecek.';log('Manuel hedef yazma hatası: '+e.message);}
 finally{
   busy=false;render();
   // Kullanıcı yazma sürerken değeri değiştirdiyse son hedefi de uygula.
   if(manualTarget!==wanted&&!cfg.auto&&mode==='ble')manualSyncTimer=setTimeout(syncManualTarget,650);
 }
}

async function manualCommand(operation){
 if(operation==='stop'&&mode==='ble'){
    if(!ble.canStop){log('STOP: bağlantı yok.');return;}
 }else if(!canControl()||busy){log('Manuel komut gönderilemedi: Bluetooth bağlantısı veya cihaz verisi hazır değil.');return;}
 busy=true;render();
 try{
   // Manuel START/STOP butonu başlı başına açık komuttur; ikinci izin/onay sorulmaz.
   // Yalnızca ileri teknik mod değiştirme işlemi ayrıca onaylanır.
   if(operation==='restore'&&!window.confirm('Isıtıcı tamamen durmuşken Mod 0 seçilsin mi?'))return;
   if(cfg.auto && (operation==='start'||operation==='stop'))switchAutoPreference(false);
   let result;
   if(operation==='start'){
     // Dizi C START B4, cihazın geri okunan HEDEF değerini kullanır.
     // Bu yüzden manuel hedef yazılmadan ve onaylanmadan START göndermeyiz.
     clearTimeout(manualSyncTimer);manualSyncTimer=null;
     const observedTarget=ble.lastVerifiedStatus?.target;
     if(observedTarget!==manualTarget){
       manualHint=`Manuel hedef ${manualTarget}°C cihaza yazılıyor…`;render();
       const change=await ble.target(manualTarget);
       if(!change?.confirmed || ble.lastVerifiedStatus?.target!==manualTarget)
         throw new Error('Manuel hedef cihazdan doğrulanamadı. Güvenlik için START gönderilmedi.');
     }
     cfg.target=manualTarget;save();
     manualHint=`Webasto hedefi ${manualTarget}°C doğrulandı; START gönderiliyor.`;
     render();
     result=await ble.start();
   }
   else if(operation==='stop')result=await ble.stop();
   else if(operation==='restore')result={confirmed:await ble.restoreTemperatureMode()};
   const label=operation==='restore'?'Mod 0':operation.toUpperCase();
   $('lastTestResult').textContent=`${label}: ${result?.confirmed?'Tamamlandı':'Doğrulama bekleniyor'}.`;
   log('MANUEL '+label+': '+(result?.confirmed?'durum değişimi görüldü':'etki doğrulanmadı'));
   if(result?.confirmed && operation==='start'){activity('start',`Manuel START doğrulandı · ${room?.toFixed(1)??'—'}°C`);silentNotice('Webasto çalıştırıldı','Manuel START doğrulandı.');}
   if(result?.confirmed && operation==='stop'){activity('stop',`Manuel STOP doğrulandı · ${room?.toFixed(1)??'—'}°C`);silentNotice('Webasto durduruldu','Manuel STOP doğrulandı.');}
   if(operation==='stop'){const at=Date.now();engine.lastStopSentAt=at;localStorage.setItem(LAST_STOP_KEY,String(at));}
 }catch(e){warning('Manuel '+operation+' başarısız: '+e.message);$('lastTestResult').textContent=e.message;}
 finally{busy=false;render();}
}
$('startBtn').onclick=()=>manualCommand('start');
$('stopBtn').onclick=()=>manualCommand('stop');
$('restoreModeBtn').onclick=()=>manualCommand('restore');
$('connectBtn').onclick=async()=>{
 busy=true;render();
 try{
  const name=await ble.connect();mode='ble';
  // Bağlantı kurulurken bildirim gelmişse bu okumayı silme; CRC kontrolü ble.js'de yapıldı.
  const status=ble.lastVerifiedStatus;
  lastUpdate=status?ble.lastStatusAt:0;
  if(status){room=status.roomTemp;caseTemp=status.caseTemp;voltage=status.voltage;targetOnDevice=status.target;fan=status.fan;pump=status.pump;glow=status.glow;state=status.stateCode;errorFlags=status.errorFlags;}
  log('Cihaz bağlandı: '+name+(cfg.auto?' · otomatik tercih korunuyor':''));
  activity('info','Bluetooth bağlantısı kuruldu'+(cfg.auto?' · otomatik mod açık':''));
 }catch(e){mode='none';log('Bağlantı kurulamadı: '+e.message);window.alert('Bluetooth bağlantısı kurulamadı: '+e.message);}
 finally{
   busy=false;render();
   // Yeni bağlantıdan sonra cihazın taze, CRC-doğrulanmış durumunu değerlendir.
   // STOP/START kararını sadece otomatik motor verir; bağlantı kurmak kör komut değildir.
   if(mode==='ble'&&cfg.auto&&autoActive&&fresh()&&ble.lastVerifiedStatus)autoStep(ble.lastVerifiedStatus);
 }
};
$('disconnectBtn').onclick=()=>{
 engine.reset();releaseWake();ble.disconnect();mode='none';room=null;state=null;lastUpdate=0;
 // Kullanıcı yalnızca Bluetooth'u kesti; otomatik mod tercihini kapatmadı.
 activity('info','Bluetooth bağlantısı kullanıcı tarafından kesildi · otomatik tercih korunuyor');render();
};
$('silentToggle').onchange=async e=>{
 options.silent=e.target.checked;saveOptions();
 if(options.silent&&'Notification' in window&&Notification.permission==='default'){
   try{const permission=await Notification.requestPermission();if(permission!=='granted')log('Tarayıcı bildirim izni verilmedi. Geçmiş kaydı yine çalışır.');}catch(e){log('Bildirim izni hatası: '+e.message);}
 }
 render();
};
$('nightToggle').onchange=e=>{options.night=e.target.checked;saveOptions();render();};
$('clearHistoryBtn').onclick=()=>{if(!window.confirm('Çalışma geçmişindeki kayıtlar silinsin mi?'))return;history=[];saveHistory();renderHistory();};
function download(name,content,mime){const blob=new Blob([content],{type:mime}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
$('exportHistoryBtn').onclick=()=>download('webasto-calisma-gecmisi.csv',historyCsv(history),'text/csv;charset=utf-8');
$('exportBtn').onclick=()=>download('webasto-tani.txt',logs.join('\n'),'text/plain;charset=utf-8');
$('readBtn').onclick=()=>ble.read();
async function autoCommand(operation,temperature){
 if(busy){log('Otomatik '+operation+' ertelendi; başka bir işlem sürüyor.');engine.sendFailed(operation);return;}
 if(!cfg.auto||!autoActive||mode!=='ble'||!ble.connected){engine.sendFailed(operation);return;}
 busy=true;render();
 try{
  const result=operation==='start'?await ble.start():await ble.stop();
  log(`OTOMATİK ${operation.toUpperCase()}: ${result?.confirmed?'durum değişimi görüldü':'etki doğrulanmadı'}`);
  if(result?.confirmed){
   const message=`Otomatik ${operation.toUpperCase()} doğrulandı · Oda ${Number.isFinite(temperature)?temperature.toFixed(1):'—'}°C`;
   activity(operation,message);
   silentNotice(operation==='start'?'Webasto çalıştırıldı':'Webasto durduruldu',message);
  }else{activity('info',`Otomatik ${operation.toUpperCase()} gönderildi; etki doğrulanmadı`);}
  $('lastTestResult').textContent=`Otomatik ${operation.toUpperCase()}: ${result?.confirmed?'Tamamlandı':'Doğrulama bekleniyor'}.`;
 }catch(e){log('Otomatik '+operation+' komut hatası: '+e.message);engine.sendFailed(operation);activity('warning',`Otomatik ${operation.toUpperCase()} hatası: ${e.message}`);}
 finally{busy=false;render();}
}
async function syncTarget(s){
 const wanted=cfg.stop;
 if(s.target===wanted){targetSyncTries=0;return;}
 if(busy||targetSyncTries>=3||Date.now()-lastTargetSentAt<20000||!ble.canControl)return;
 targetSyncTries++;lastTargetSentAt=Date.now();busy=true;render();
 try{
   const result=await ble.target(wanted);
   if(result?.confirmed){cfg.target=wanted;save();log(`Otomatik hedef ${wanted}°C olarak eşitlendi.`);}
   else log('Hedef eşitleme gönderildi fakat geri okuma doğrulanmadı.');
 }catch(e){log('Hedef eşitleme hatası: '+e.message);}
 finally{busy=false;render();}
}
function autoStep(s){
 if(mode!=='ble'||!cfg.auto||!autoActive||!ble.connected)return;
 if(!fresh())return;
 if(s.errorFlags||s.flags&0x10){pauseAuto(s.errorFlags?'Cihaz hata bildiriyor, otomatik kontrol duraklatıldı.':'Fahrenheit modu: otomatik kontrol duraklatıldı.');warning('Webasto otomatik kontrol duraklatıldı. Cihazı kontrol et.');return;}
 // Adım 5'te fan/pompa çalışıyorsa cihaz soğutma aşamasındadır.
 // Bağlantı dönüşünde soğutma sürerken yeni START/STOP komutu göndermiyoruz.
 if((s.stateCode&0x0f)===5 && (s.fan||s.pump||s.glow)){
   lastReason='Soğutma sürüyor; cihaz tamamen durana kadar bekleniyor.';render();return;
 }
 engine.cfg={...cfg,auto:true,maxStartsPerHour:4};
 // Hedef sıcaklık eşitlenmeden START gönderilmez; bilinen çalışan 0x66/0x61 komutları aynıdır.
 if(s.target!==cfg.stop){lastReason=`Webasto hedefi ${cfg.stop}°C yapılıyor…`;
   // Çalışan ısıtıcının STOP eşiğine eriştiği durumda hedef eşitleme STOP komutunu engellemez.
   const urgentStop=engine.awaitingOff||((s.stateCode&0x0f)!==5 && s.roomTemp>=cfg.stop);
   if(!urgentStop){syncTarget(s);render();return;}
 }
 const d=engine.evaluate(s,Date.now());lastReason=d.reason;
 if(d.alert)warning(d.alert);
 if(d.disableAuto){pauseAuto(d.reason);render();return;}
 if(d.action==='start'){
    log('OTOMATİK KARAR: '+d.reason);
    autoCommand('start',s.roomTemp);
 }else if(d.action==='stop'){
    const at=Date.now();localStorage.setItem(LAST_STOP_KEY,String(at));
    log('OTOMATİK KARAR: '+d.reason);autoCommand('stop',s.roomTemp);
 }else if(s.target!==cfg.stop && !busy){syncTarget(s);}
 render();
}
// Gelen cihaz paketleri denetim kararı verir; tarayıcı kapalıyken kontrol yapılamaz.
setInterval(()=>{if(mode==='ble'&&ble.connected&&ble.writeChar&&Date.now()-(ble.lastStatusAt||0)>20000)ble.requestStatus();},15000);
setInterval(()=>{render();},3500);

// Sekmeler sadece görünürlüğü değiştirir. BLE bağlantısı ve otomatik motor sayfa boyunca çalışır.
const tabIds=['control','history','settings'];
function showTab(tab,{focus=false}={}){
 if(!tabIds.includes(tab))return;
 for(const id of tabIds){
  const active=id===tab;
  $('tab-'+id).hidden=!active;
  const btn=$('tabBtn-'+id);btn.classList.toggle('current',active);
  btn.setAttribute('aria-selected',String(active));btn.tabIndex=active?0:-1;
  if(active&&focus)btn.focus();
 }
 window.scrollTo(0,0);
}
for(const id of tabIds){
 $('tabBtn-'+id).addEventListener('click',()=>showTab(id));
 $('tabBtn-'+id).addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  e.preventDefault();
  const next=e.key==='Home'?0:e.key==='End'?tabIds.length-1:(tabIds.indexOf(id)+(e.key==='ArrowRight'?1:-1)+tabIds.length)%tabIds.length;
  showTab(tabIds[next],{focus:true});
 });
}

// Otomatik tercih kullanıcı elle KAPATANA kadar saklanır. Sayfa açılınca Bluetooth
// bağlantısı kullanıcı hareketiyle kurulur; bağlantı sonrası taze durum değerlendirilir.
log('Karavan Webasto açıldı. Bluetooth bağlantısı bekleniyor.');
if(cfg.auto)log('Otomatik mod AÇIK olarak yüklendi. Bağlantı ve taze veri geldiğinde otomatik kontrol devam edecek.');
renderHistory();renderChart();render();
