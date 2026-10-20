# Karavan Webasto — Web V3.14 (Sade)

V3.12 tasarımı korunarak V3.13’ün akıllı START/STOP eşikleri ve manuel hedef ayarı taşındı.
Demo modunun düğmeleri, veri simülasyonu ve otomatik demo döngüsü tamamen kaldırıldı.
Uygulama yalnızca gerçek Bluetooth bağlantısı ile çalışır.

## GitHub Pages kurulumu

Tüm dosyaları deponun ana dizinine yükleyin. Settings > Pages > Deploy from a branch > main / (root).
Tarayıcıda Chrome veya Edge kullanın (Web Bluetooth desteği gerekir).

## Korunan kontroller

- RE5011/HeatGenie: test edilmiş Dizi C START, STOP/CLEAR, hedef sıcaklık çerçeveleri (ble.js, protocol.mjs, command-profile.mjs değişmedi).
- 2°C minimum fark ve sınırda eşiklerin beraber hareketi.
- Ayrı manuel hedef 10–40°C, START öncesi cihazdan geri okuma.
- Otomatik tercih cihaz bağlantısı kopsa da hafızada tutulur, taze telemetri olmadan komut gönderilmez.
- 3 sekme: Kontrol, Geçmiş, Ayarlar.
- Teknik tanı kayıtlarına Ayarlar > Servis altından ulaşılabilir; ana ekrandan kaldırıldı.

## Önemli

Tarayıcı kapalıysa veya Bluetooth bağlantısı koptuysa otomatik termostat Webasto’yu kontrol edemez.
Gerçek ısıtıcı üzerinde bu sürüm fiziksel olarak test edilmemiştir.
