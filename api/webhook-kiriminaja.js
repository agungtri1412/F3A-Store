// =====================================================================
// Webhook KiriminAja — alamat yang dipanggil KiriminAja saat status paket berubah.
// Tahap ini: hanya menerima & mencatat (lihat di Vercel → Logs).
// Nanti dipakai untuk mengubah status pesanan otomatis.
// =====================================================================
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, info: 'Webhook F3A Store aktif' });
  }
  console.log('Webhook KiriminAja masuk:', JSON.stringify(req.body || {}));
  return res.status(200).json({ status: true });
};
