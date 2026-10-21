// =====================================================================
// Halaman uji koneksi ke KiriminAja (sementara, boleh dihapus setelah tes).
// Buka: https://f3astore.vercel.app/api/ka-cek
// Menampilkan: apakah API key diterima, IP server Vercel saat ini,
// dan contoh hasil pencarian kecamatan. API key TIDAK ditampilkan.
// =====================================================================
module.exports = async (req, res) => {
  const key = process.env.KIRIMINAJA_API_KEY;
  const env = (process.env.KIRIMINAJA_ENV || 'sandbox').toLowerCase();
  const base = env === 'production' ? 'https://client.kiriminaja.com' : 'https://tdev.kiriminaja.com';

  // IP keluar server Vercel saat ini (untuk dibandingkan dengan IP yang didaftarkan)
  let ipServer = null;
  try { ipServer = (await (await fetch('https://api.ipify.org?format=json')).json()).ip; } catch (e) { /* abaikan */ }

  if (!key) {
    return res.status(200).json({ ok: false, pesan: 'KIRIMINAJA_API_KEY belum diisi di Vercel (Settings → Environment Variables), lalu Redeploy.', env, ipServer });
  }

  try {
    const r = await fetch(base + '/api/mitra/v2/get_address_by_name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ search: 'tambaksari' })
    });
    const teks = await r.text();
    let data;
    try { data = JSON.parse(teks); } catch (e) { data = teks.slice(0, 300); }
    return res.status(200).json({
      ok: r.ok && data && data.status !== false,
      env,
      httpStatus: r.status,
      ipServer,
      contoh: data
    });
  } catch (e) {
    return res.status(200).json({ ok: false, env, ipServer, pesan: e.message });
  }
};
