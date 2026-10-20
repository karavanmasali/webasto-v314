/** Yalnızca doğrulanan komut/durum olayları; ısıtıcının gerçek yanma süresini ölçmez. */
export const HISTORY_LIMIT = 300;
export const ALLOWED_TYPES = new Set(['start','stop','info','warning']);
export function normalizeHistory(input) {
  if(!Array.isArray(input)) return [];
  return input.filter(e=>e && ALLOWED_TYPES.has(e.type) && Number.isFinite(e.at) && typeof e.message==='string' && e.message.length<=250).slice(-HISTORY_LIMIT);
}
export function addHistory(history,type,message,at=Date.now()) {
  if(!ALLOWED_TYPES.has(type)||!Number.isFinite(at)||typeof message!=='string')throw Error('Geçersiz olay');
  return [...history,{at,type,message:message.slice(0,250)}].slice(-HISTORY_LIMIT);
}
export function localDayKey(date) { const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,'0'),d=String(date.getDate()).padStart(2,'0');return `${y}-${m}-${d}`; }
export function dayStats(history,now=new Date()) {
  const key=localDayKey(now),today=history.filter(e=>localDayKey(new Date(e.at))===key);
  return {starts:today.filter(e=>e.type==='start').length,stops:today.filter(e=>e.type==='stop').length,last:history.length?history[history.length-1]:null};
}
const quoteCsv=s=>'"'+String(s??'').replaceAll('"','""')+'"';
export function historyCsv(history){return '\ufeff'+[['Tarih','Saat','Tür','Açıklama'],...history.map(e=>{const d=new Date(e.at);return [d.toLocaleDateString('tr-TR'),d.toLocaleTimeString('tr-TR'),e.type,e.message];})].map(row=>row.map(quoteCsv).join(';')).join('\r\n');}

/** Tamamlanan kayıtlı START→STOP çiftlerinden bugünkü yaklaşık süre. */
export function recordedRuntimeMs(events, now=new Date()) {
  const dayStart=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  let open=null,total=0;
  for(const e of events){
    if(e.type==='start')open=e.at;
    if(e.type==='stop'&&open!==null){
      const begin=Math.max(open,dayStart),end=Math.min(e.at,now.getTime());
      if(end>begin)total+=end-begin;
      open=null;
    }
  }
  return total;
}
export function normalizeTemperatures(input){
  if(!Array.isArray(input))return [];
  return input.filter(e=>e&&Number.isFinite(e.at)&&Number.isFinite(e.value)&&e.value>=-40&&e.value<=100&&['ble','demo'].includes(e.mode)).slice(-1200);
}
export function addTemperature(points,mode,value,at=Date.now()){
  if(!['ble','demo'].includes(mode)||!Number.isFinite(value)||!Number.isFinite(at))return points;
  const newest=[...points].reverse().find(e=>e.mode===mode);
  if(newest && at-newest.at < 120000 && (at-newest.at < 30000 || Math.abs(newest.value-value) < .3))return points;
  return [...points.filter(e=>at-e.at<3*86400000),{at,mode,value}].slice(-1200);
}
