// =====================================================================
// api/ongkir.js — penghubung website ↔ KiriminAja (berjalan di server Vercel)
//
// API key KiriminAja disimpan di Vercel (Environment Variables), TIDAK di website.
// Variabel yang dipakai:
//   KIRIMINAJA_API_KEY  → API key dari KiriminAja
//   KIRIMINAJA_ENV      → "sandbox" atau "production"
//   ONGKIR_RAHASIA      → kode rahasia dari SQL tahap 5 (untuk tanda tangan ongkir)
//
// Cara pakai (POST JSON):
//   { "aksi": "cari",  "q": "bulak" }
//      → daftar kecamatan [{ id, text }]
//   { "aksi": "tarif", "asal_id": 6155, "tujuan_id": 6438, "berat": 250, "nilai": 85000, "kurir": ["jne","jnt"] }
//      → daftar layanan + ongkir. Setiap layanan diberi tanda tangan (sig) supaya
//        database bisa memastikan ongkirnya asli dari sini, bukan diketik di browser.
// =====================================================================
const crypto = require('crypto');

const KODE_KURIR_DIKENAL = ['jne', 'jnt', 'sicepat', 'anteraja', 'ninja', 'idx', 'sap', 'lion', 'posindonesia', 'tiki', 'spx', 'paxel', 'rpx', 'ncs', 'sentral', 'jtcargo'];
const BERLAKU_DETIK = 2 * 60 * 60;   // tarif berlaku 2 jam

function baseUrl() {
  return (process.env.KIRIMINAJA_ENV || 'sandbox').toLowerCase() === 'production'
    ? 'https://client.kiriminaja.com'
    : 'https://tdev.kiriminaja.com';
}

async function panggilKA(jalur, body) {
  const r = await fetch(baseUrl() + jalur, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer ' + process.env.KIRIMINAJA_API_KEY
    },
    body: JSON.stringify(body || {})
  });
  const teks = await r.text();
  let data;
  try { data = JSON.parse(teks); } catch (e) { data = { status: false, text: teks.slice(0, 200) }; }
  return { http: r.status, data };
}

// Tanda tangan ongkir — urutan & format HARUS sama dengan fungsi buat_pesanan di database
function tandaTangan(q) {
  const pesan = [q.tujuan_id, q.kode, q.tipe, q.berat, q.ongkir, q.cod, q.exp].join('|');
  return crypto.createHmac('sha256', process.env.ONGKIR_RAHASIA).update(pesan).digest('hex');
}

// Ubah satu baris hasil KiriminAja ke format sederhana (tahan beda nama kolom)
function rapikanLayanan(x) {
  const kode = String(x.service || x.courier || x.courier_code || x.code || '').toLowerCase();
  const tipe = String(x.service_type || x.type || x.service_code || '');
  const ongkir = Math.round(Number(x.cost ?? x.price ?? x.tariff ?? x.final_price ?? x.shipping_cost ?? 0));
  const namaKurir = x.service_name || x.courier_name || x.name || kode.toUpperCase();
  return {
    kode,
    tipe,
    nama: String(namaKurir).includes(tipe) || !tipe ? String(namaKurir) : `${namaKurir} ${tipe}`,
    ongkir,
    etd: String(x.etd || x.estimation || x.estimated || '').replace(/\s*hari\s*/i, ''),
    cod: x.cod === true || x.cod === 1 || x.cod === '1' || x.cod === 'true' ? 1 : 0
  };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, pesan: 'Gunakan POST.' });
  if (!process.env.KIRIMINAJA_API_KEY) return res.status(500).json({ ok: false, pesan: 'KIRIMINAJA_API_KEY belum diatur di Vercel.' });

  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  try {
    // ---------- Cari kecamatan ----------
    if (b.aksi === 'cari') {
      const q = String(b.q || '').trim();
      if (q.length < 3) return res.status(200).json({ ok: true, data: [] });
      const { data } = await panggilKA('/api/mitra/v2/get_address_by_name', { search: q.slice(0, 60) });
      const daftar = Array.isArray(data.data) ? data.data : (Array.isArray(data.datas) ? data.datas : []);
      res.setHeader('Cache-Control', 's-maxage=86400');   // hasil pencarian boleh di-cache 1 hari
      return res.status(200).json({ ok: true, data: daftar.slice(0, 15).map((d) => ({ id: d.id, text: d.text })) });
    }

    // ---------- Cek tarif ----------
    if (b.aksi === 'tarif') {
      if (!process.env.ONGKIR_RAHASIA) return res.status(500).json({ ok: false, pesan: 'ONGKIR_RAHASIA belum diatur di Vercel.' });
      const asal = parseInt(b.asal_id, 10);
      const tujuan = parseInt(b.tujuan_id, 10);
      const berat = Math.max(1, Math.min(50000, parseInt(b.berat, 10) || 0));
      const nilai = Math.max(0, parseInt(b.nilai, 10) || 0);
      const kurir = (Array.isArray(b.kurir) ? b.kurir : []).map((k) => String(k).toLowerCase()).filter((k) => KODE_KURIR_DIKENAL.includes(k));
      if (!asal || !tujuan) return res.status(400).json({ ok: false, pesan: 'Alamat asal/tujuan belum lengkap.' });
      if (!kurir.length) return res.status(400).json({ ok: false, pesan: 'Belum ada kurir aktif.' });

      const { http, data } = await panggilKA('/api/mitra/v6.1/shipping_price', {
        origin: asal, destination: tujuan, weight: berat, item_value: nilai, insurance: 0, courier: kurir
      });
      if (http !== 200 || data.status === false) {
        return res.status(200).json({ ok: false, pesan: data.text || 'Gagal mengambil ongkir dari KiriminAja.' });
      }

      const mentah = data.results || data.result || data.data || data.datas || [];
      const exp = Math.floor(Date.now() / 1000) + BERLAKU_DETIK;
      const layanan = (Array.isArray(mentah) ? mentah : [])
        .map(rapikanLayanan)
        .filter((l) => l.kode && l.ongkir > 0 && kurir.includes(l.kode))
        .sort((a, c) => a.ongkir - c.ongkir)
        .map((l) => {
          const q = { ...l, tujuan_id: tujuan, berat, exp };
          return { ...q, sig: tandaTangan(q) };
        });

      return res.status(200).json({
        ok: true,
        layanan,
        // Kalau format KiriminAja berubah & tidak terbaca, contoh mentahnya ikut dikirim untuk diperiksa
        contoh_mentah: layanan.length ? undefined : (Array.isArray(mentah) ? mentah.slice(0, 2) : mentah)
      });
    }

    return res.status(400).json({ ok: false, pesan: 'Aksi tidak dikenal.' });
  } catch (e) {
    console.error('api/ongkir error:', e);
    return res.status(500).json({ ok: false, pesan: 'Terjadi kesalahan di server ongkir.' });
  }
};
