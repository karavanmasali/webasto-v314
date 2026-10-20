/* RE5011/HeatGenie register-report decoder. Read-only. No actuator commands. */
export const HEATGENIE_SERVICE = '0000181a-0000-1000-8000-00805f9b34fb';
export const HEATGENIE_READ_CHAR = '00003a00-0000-1000-8000-00805f9b34fb';
export const HEATGENIE_WRITE_CHAR = '00003a01-0000-1000-8000-00805f9b34fb';

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof DataView) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('DataView, Uint8Array veya ArrayBuffer bekleniyordu.');
}
export function crc16CcittZero(input) {
  const bytes = toBytes(input);
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
export function parseHeatGenieStatus(input) {
  const bytes = toBytes(input);
  if (bytes.length !== 52) throw new Error(`Beklenmeyen HeatGenie paket uzunluğu: ${bytes.length} (52 bekleniyor).`);
  if (bytes[0] !== 0xaa || bytes[7] !== 0xf2) throw new Error('HeatGenie AA/F2 durum paketi değil.');
  const receivedCrc = (bytes[50] << 8) | bytes[51];
  const actualCrc = crc16CcittZero(bytes.subarray(0, 50));
  if (actualCrc !== receivedCrc) throw new Error('CRC16 doğrulaması başarısız.');
  const data = new DataView(bytes.buffer, bytes.byteOffset + 8, 40);
  const raw = (offset) => data.getInt16(offset, true);
  const optionalProbe = (offset) => raw(offset) === 32760 ? null : raw(offset) / 10;
  const flags = data.getUint8(1);
  return {
    stateCode: data.getUint8(0),
    flags,
    voltage: data.getUint16(2, true) / 10,
    altitude: data.getUint16(4, true),
    roomTemp: raw(6) / 10,
    caseTemp: raw(8) / 10,
    intakeTemp: optionalProbe(16),
    outletTemp: optionalProbe(18),
    errorFlags: data.getUint16(20, true),
    pump: Boolean(flags & 0b00000011),
    fan: Boolean(flags & 0b00000100),
    glow: Boolean(flags & 0b00001000),
    setLevel: data.getUint8(32),
    target: data.getUint8(33),
    register34: data.getUint8(34), // Ham alan; anlamı kesin değil (02→01 START sonrası gözlendi).
    crcOk: true,
  };
}
