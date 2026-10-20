/**
 * HeatGenie/Boygu command format based on diesel-heater-ble 0.3.8,
 * ProtocolHeatGenie.build_command() under MIT license.
 * V3.9 START B4=target °C is based on user-reported physically successful RE5011 Dizi C test.
 * Copyright (c) 2024 Spettacolo83 (original Python library).
 */
import {crc16CcittZero} from './protocol.mjs?v=3.10.0';
export const commandProfile = Object.freeze({
  source: 'User-tested RE5011 Dizi C from re5011_start_test.html; CRC16/XMODEM',
  hardwareVerified: false,
  targetMin: 10,
  targetMax: 40,
});
export const hexBytes = bytes => [...bytes].map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
export function buildHeatGenieFrame(command, first, second, third) {
  for (const n of [command, first, second, third]) if (!Number.isInteger(n) || n<0 || n>255) throw new RangeError('Komut baytları 0-255 aralığında olmalı.');
  const out = Uint8Array.from([0xAA,0x00,command,first,second,third,0,0]);
  const crc = crc16CcittZero(out.subarray(0,6));
  out[6] = crc >> 8; out[7] = crc & 255;
  return out;
}
export function guardedBuild(operation, target) {
  switch (operation) {
    case 'start':
      // Kullanıcının gerçekten ateşlemeyi başlattığını bildirdiği Dizi C:
      // CMD 0x61, B3=0x01, B4=cihazdan okunan HEDEF SICAKLIK (10–40), B5=0.
      // Orijinal APK random nonce yaklaşımı V3.7'de ayrı test edilmişti.
      if(!Number.isInteger(target) || target<10 || target>40) throw new RangeError('START B4 sıcaklığı 10–40 °C olmalı.');
      return buildHeatGenieFrame(0x61,0x01,target,0);
    case 'auto-update': return buildHeatGenieFrame(0x65,0x02,0x14,0x1e); // ProtocolHeatGenie 0.3.8: command 1, register area 2, 20, 30
    case 'manual-gear-mode': return buildHeatGenieFrame(0x66,0x00,0x00,0x01); // Manual power mode 1: supported HeatGenie run mode
    case 'start-stop-mode': return buildHeatGenieFrame(0x66,0x00,0x00,0x02); // ProtocolHeatGenie: run-mode 2 = start/stop
    case 'constant-mode': return buildHeatGenieFrame(0x66,0x00,0x00,0x00); // HeatGenie 0.3.8 command 2 / argument 0
    case 'stop': return buildHeatGenieFrame(0x61,0x02,0xff,0);
    case 'target':
      if(!Number.isInteger(target) || target<10 || target>40) throw new RangeError('Hedef sıcaklık 10–40 °C arasında olmalı.');
      return buildHeatGenieFrame(0x66,0x01,0x00,target);
    default: throw new Error('Bilinmeyen veya desteklenmeyen işlem.');
  }
}
