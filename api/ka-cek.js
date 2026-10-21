// =====================================================================
// Halaman uji koneksi ke KiriminAja (sementara, boleh dihapus setelah tes).
// Buka: https://f3astore.vercel.app/api/ka-cek
// Menampilkan: status koneksi, IP server, contoh cari kecamatan,
// daftar kurir aktif, dan contoh cek ongkir Surabaya → Jakarta.
// API key TIDAK ditampilkan.
// =====================================================================
module.exports = async (req, res) => {
  const key = process.env.KIRIMINAJA_API_KEY;
  const env = (process.env.KIRIMINAJA_ENV || 'sandbox').toLowerCase();
  const base = env === 'production' ? 'https://client.kiriminaja.com' : 'https://tdev.kiriminaja.com';
  const kirim = (hasil) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(hasil, null, 2));
  };

  let ipServer = null;
  try { ipServer = (await (await fetch('https://api.ipify.org?format=json')).json()).ip; } catch (e) { /* abaikan */ }
  if (!key) return kirim({ ok: false, pesan: 'KIRIMINAJA_API_KEY belum diisi di Vercel, lalu Redeploy.', env, ipServer });

  const panggil = async (jalur, body) => {
    try {
      const r = await fetch(base + jalur, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body || {})
      });
      const teks = await r.text();
      try { return { http: r.status, data: JSON.parse(teks) }; } catch (e) { return { http: r.status, data: teks.slice(0, 300) }; }
    } catch (e) {
      return { http: 0, data: e.message };
    }
  };

  const cari = await panggil('/api/mitra/v2/get_address_by_name', { search: 'gambir' });
  const tujuan = cari.data && Array.isArray(cari.data.data) && cari.data.data[0];
  const kurir = await panggil('/api/mitra/couriers');
  const ongkir = tujuan ? await panggil('/api/mitra/v6.1/shipping_price', {
    origin: 6155,                 // Tambaksari, Surabaya
    destination: tujuan.id,
    weight: 1000,
    item_value: 100000,
    insurance: 0,
    courier: ['jne', 'jnt', 'sicepat', 'anteraja', 'ninja', 'idx', 'sap', 'lion', 'posindonesia']
  }) : null;

  // Ringkas: tampilkan 3 hasil pertama saja supaya muat di layar
  const ringkas = (d) => {
    if (!d || typeof d !== 'object') return d;
    const salin = { ...d };
    for (const k of ['results', 'result', 'data', 'datas']) {
      if (Array.isArray(salin[k])) salin[k] = { jumlah: salin[k].length, tiga_pertama: salin[k].slice(0, 3) };
    }
    return salin;
  };

  return kirim({
    ok: cari.http === 200,
    env,
    ipServer,
    tujuan_contoh: tujuan || null,
    kurir_aktif: kurir.data && Array.isArray(kurir.data.datas) ? kurir.data.datas.map((k) => k.code + ' (' + k.type + ')').join(', ') : kurir.data,
    ongkir_http: ongkir && ongkir.http,
    ongkir: ongkir && ringkas(ongkir.data)
  });
};
