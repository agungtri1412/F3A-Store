// =====================================================================
// api/kiriman.js — Request pickup, cetak label, lacak, batal, cek bayar (KiriminAja)
// Berjalan di server Vercel. Aksi admin WAJIB membawa token login admin Supabase.
//
// Environment Variables di Vercel:
//   KIRIMINAJA_API_KEY, KIRIMINAJA_ENV (sandbox/production)
//   KIRIMINAJA_PREFIX  → prefix order yang didaftarkan di KiriminAja (default: F3A)
//   SUPABASE_URL       → sama dengan di config.js
//   SUPABASE_ANON_KEY  → publishable key (sb_publishable_...), sama dengan di config.js
//
// Aksi (POST JSON):
//   Admin : jadwal | pickup {id, jadwal} | lacak {id} | label {id} | batal {id, alasan} | bayar {id}
//   Publik: lacak_publik {resi, hp4}   ← untuk halaman Lacak pembeli
// =====================================================================

const PACKAGE_TYPE_ID = 7;   // sesuai dokumentasi KiriminAja

const baseKA = () => ((process.env.KIRIMINAJA_ENV || 'sandbox').toLowerCase() === 'production'
  ? 'https://client.kiriminaja.com' : 'https://tdev.kiriminaja.com');

async function panggilKA(jalur, body, query, metode = 'POST') {
  const url = new URL(baseKA() + jalur);
  if (query) Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, {
    method: metode,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + process.env.KIRIMINAJA_API_KEY },
    body: metode === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const teks = await r.text();
  let data;
  try { data = JSON.parse(teks); } catch (e) { data = { status: false, text: teks.slice(0, 300) }; }
  if (!r.ok && data.status === undefined) data.status = false;
  return data;
}

// Akses database Supabase (pakai token admin kalau ada, supaya aturan RLS tetap berlaku)
async function supa(jalur, { method = 'GET', token, body } = {}) {
  const r = await fetch(process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + jalur, {
    method,
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + (token || process.env.SUPABASE_ANON_KEY),
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const teks = await r.text();
  let data = null;
  try { data = teks ? JSON.parse(teks) : null; } catch (e) { data = teks; }
  if (!r.ok) throw new Error((data && (data.message || data.error)) || ('Database error ' + r.status));
  return data;
}

const ke0 = (hp) => String(hp || '').replace(/\D/g, '').replace(/^62/, '0');                 // 62812.. → 0812..
const kodeposDari = (teks) => ((String(teks || '').match(/(\d{5})\s*$/) || [])[1] || '');
const pesanKA = (d) => d.text || d.message || (Array.isArray(d.errors) && d.errors.join(', ')) || 'Ditolak KiriminAja.';
const awbDari = (d) => (Array.isArray(d.details) && d.details.find((x) => x.awb) || {}).awb
  || (d.details && !Array.isArray(d.details) && d.details.awb) || null;

function orderIdKA(p) {
  const prefix = (process.env.KIRIMINAJA_PREFIX || 'F3A').toUpperCase();
  const dasar = `${prefix}-${String(p.resi).replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
  return (p.ka_percobaan > 0 ? `${dasar}-${p.ka_percobaan + 1}` : dasar).slice(0, 20);
}

async function ambilPesanan(id, token) {
  const rows = await supa(`pesanan?id=eq.${parseInt(id, 10)}&select=*`, { token });
  if (!rows || !rows.length) throw new Error('Pesanan tidak ditemukan.');
  return rows[0];
}
const simpanPesanan = (id, ubah, token) => supa(`pesanan?id=eq.${parseInt(id, 10)}`, { method: 'PATCH', token, body: ubah });

// Ringkas hasil tracking KiriminAja
function rapikanTracking(d) {
  const det = d.details || {};
  const riwayat = (Array.isArray(d.histories) ? d.histories : []).map((h) => ({
    waktu: h.created_at, status: h.status, kode: h.status_code, penerima: h.receiver || null
  }));
  return {
    awb: det.awb || null,
    layanan: det.service_name || det.service || null,
    estimasi: det.estimation || null,
    terkirim: !!det.delivered,
    terkirim_pada: det.delivered_at || null,
    dikirim_pada: det.shipped_at || null,
    dikembalikan: !!det.refunded,
    riwayat
  };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, pesan: 'Gunakan POST.' });
  for (const v of ['KIRIMINAJA_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
    if (!process.env[v]) return res.status(500).json({ ok: false, pesan: `${v} belum diatur di Vercel (Environment Variables).` });
  }
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  try {
    // =================== PUBLIK: lacak untuk pembeli ===================
    if (b.aksi === 'lacak_publik') {
      const rows = await supa('rpc/lacak_pesanan', { method: 'POST', body: { p_resi: String(b.resi || ''), p_hp4: String(b.hp4 || '') } });
      const p = rows && rows[0];
      if (!p) return res.status(200).json({ ok: false, pesan: 'Pesanan tidak ditemukan.' });
      if (!p.ka_order_id) return res.status(200).json({ ok: true, belum: true });
      const d = await panggilKA('/api/mitra/tracking', { order_id: p.ka_order_id });
      if (d.status === false) return res.status(200).json({ ok: true, belum: true });
      const t = rapikanTracking(d);
      return res.status(200).json({ ok: true, awb: t.awb, layanan: t.layanan, terkirim: t.terkirim, riwayat: t.riwayat });
    }

    // =================== ADMIN: cek token login ===================
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ ok: false, pesan: 'Harus login admin.' });
    let admin = false;
    try { admin = (await supa('rpc/is_admin', { method: 'POST', token, body: {} })) === true; } catch (e) { admin = false; }
    if (!admin) return res.status(403).json({ ok: false, pesan: 'Akses ditolak: bukan admin.' });

    // ---------- Jadwal pickup ----------
    if (b.aksi === 'jadwal') {
      const d = await panggilKA('/api/mitra/v2/schedules');
      // Cari daftar jadwal di mana pun letaknya dalam respons (format KiriminAja bisa berbeda)
      const cariArray = (o, dalam = 0) => {
        if (Array.isArray(o)) return o;
        if (!o || typeof o !== 'object' || dalam > 3) return null;
        for (const k of ['schedules', 'schedule', 'data', 'datas', 'results', 'result']) {
          const hasil = cariArray(o[k], dalam + 1);
          if (hasil) return hasil;
        }
        return null;
      };
      const mentah = cariArray(d) || [];
      const jadwal = mentah.map((x) => {
        if (typeof x === 'string') return { nilai: x, label: x };
        const nilai = x.clock || x.schedule || x.datetime || x.value || x.start || x.pickup_time
          || (x.date && x.time ? `${x.date} ${x.time}${String(x.time).length === 5 ? ':00' : ''}` : (x.time || x.date));
        const label = x.label || x.text || (x.until ? `${nilai} s/d ${x.until}` : nilai);
        return { nilai, label, lewat: x.expired === true || x.expired === 1 || x.libur === true };
      }).filter((x) => x.nilai && !x.lewat);
      return res.status(200).json({ ok: true, jadwal, contoh_mentah: jadwal.length ? undefined : d });
    }

    // ---------- Saldo KA Credit ----------
    if (b.aksi === 'saldo') {
      const d = await panggilKA('/api/mitra/v6.2/credit/balance', null, null, 'GET');
      const cari = [d.results, d.result, d.data, d].find((x) => x && x.balance !== undefined);
      if (!cari) return res.status(200).json({ ok: false, pesan: pesanKA(d) });
      return res.status(200).json({ ok: true, saldo: Number(cari.balance) });
    }

    const p = await ambilPesanan(b.id, token);

    // ---------- Request pickup (buat paket di KiriminAja) ----------
    if (b.aksi === 'pickup') {
      if (p.ka_order_id) return res.status(200).json({ ok: false, pesan: 'Pesanan ini sudah di-request pickup. Batalkan dulu kalau mau ulang.' });
      if (p.status === 'Dibatalkan') return res.status(200).json({ ok: false, pesan: 'Pesanan berstatus Dibatalkan.' });
      if (p.metode_bayar !== 'COD' && p.status === 'Menunggu Bayar') return res.status(200).json({ ok: false, pesan: 'Pembeli belum bayar. Ubah status ke Dikemas setelah pembayaran diterima.' });
      if (!p.kecamatan_id || !p.kelurahan_id || !p.layanan_kode || !p.layanan_tipe) {
        return res.status(200).json({ ok: false, pesan: 'Pesanan ini dibuat sebelum ongkir KiriminAja aktif (data kecamatan/kelurahan/layanan tidak lengkap). Buat pickup manual dari dashboard KiriminAja.' });
      }
      const [prodRows, cfgRows] = await Promise.all([
        supa(`produk?id=eq.${p.produk_id}&select=*`, { token }),
        supa('pengaturan?id=eq.1&select=data', { token })
      ]);
      const prod = (prodRows && prodRows[0]) || {};
      const asal = ((cfgRows && cfgRows[0] && cfgRows[0].data) || {}).asal || {};
      if (!asal.kecamatan_id || !asal.kelurahan_id) return res.status(200).json({ ok: false, pesan: 'Lengkapi kecamatan & kelurahan pengirim di Pengaturan.' });
      if (String(asal.alamat || '').length < 10) return res.status(200).json({ ok: false, pesan: 'Alamat pickup di Pengaturan minimal 10 karakter.' });
      if (!b.jadwal) return res.status(200).json({ ok: false, pesan: 'Pilih jadwal pickup.' });

      const jumlah = p.jumlah || 1;
      const alamatTujuan = String(p.alamat).length >= 10 ? p.alamat : `${p.alamat}, ${p.kota}`;
      const orderId = orderIdKA(p);
      const payload = {
        address: String(asal.alamat).slice(0, 200),
        phone: ke0(asal.hp),
        name: String(asal.nama || 'F3A Store').slice(0, 50),
        zipcode: kodeposDari(asal.kecamatan),
        kecamatan_id: asal.kecamatan_id,
        kelurahan_id: asal.kelurahan_id,
        schedule: b.jadwal,
        platform_name: 'F3A Store',
        packages: [{
          order_id: orderId,
          destination_name: String(p.nama).slice(0, 50),
          destination_phone: ke0(p.no_hp),
          destination_address: alamatTujuan.slice(0, 200),
          destination_kecamatan_id: p.kecamatan_id,
          destination_kelurahan_id: p.kelurahan_id,
          destination_zipcode: p.kodepos || kodeposDari(p.kota),
          weight: p.berat_gram || (prod.berat_gram || 250) * jumlah,
          length: prod.panjang_cm || 10,
          width: prod.lebar_cm || 10,
          height: (prod.tinggi_cm || 10) * jumlah,
          qty: jumlah,
          item_value: Math.max(1000, (p.subtotal ?? p.harga * jumlah) - (p.diskon || 0)),
          shipping_cost: p.ongkir,
          service: p.layanan_kode,
          service_type: p.layanan_tipe,
          cod: p.metode_bayar === 'COD' ? p.total : 0,
          package_type_id: PACKAGE_TYPE_ID,
          item_name: `${p.produk_nama} x${jumlah}`.slice(0, 255),
          // KiriminAja juga mewajibkan ukuran per barang (width/length/height)
          items: [{
            name: p.produk_nama, price: p.harga, qty: jumlah, weight: prod.berat_gram || 250,
            length: prod.panjang_cm || 10, width: prod.lebar_cm || 10, height: prod.tinggi_cm || 10
          }],
          note: `Order ${p.resi}`.slice(0, 50)
        }]
      };

      // Cara bayar ongkir non-COD (endpoint resmi terbaru v6.2, sama seperti plugin resmi KiriminAja):
      //   'credit' → potong saldo KA Credit (PIN opsional; kalau akun tidak pakai PIN, pin TIDAK dikirim)
      //   lainnya  → 'cash' (bayar lewat QRIS setelah request)
      // Pesanan COD tidak mengirim payment_method.
      const pakaiCredit = p.metode_bayar !== 'COD' && b.bayar_ongkir === 'credit';
      const kirim = { ...payload };
      if (p.metode_bayar !== 'COD') kirim.payment_method = pakaiCredit ? 'credit' : 'cash';
      if (pakaiCredit) {
        const s = await panggilKA('/api/mitra/v6.2/credit/balance', null, null, 'GET');
        const ds = [s.results, s.result, s.data, s].find((x) => x && x.balance !== undefined);
        if (ds && Number(ds.balance) < Number(p.ongkir || 0)) {
          return res.status(200).json({ ok: false, pesan: `Saldo KA Credit Rp${Number(ds.balance).toLocaleString('id-ID')} tidak cukup untuk ongkir Rp${Number(p.ongkir).toLocaleString('id-ID')}. Top up dulu.` });
        }
        const pin = String(b.pin || '').trim();
        if (pin) {
          if (!/^\d{6}$/.test(pin)) return res.status(200).json({ ok: false, pesan: 'PIN KA Credit harus 6 angka (kosongkan kalau akun tidak memakai PIN).' });
          const v = await panggilKA('/api/mitra/v6.2/pin/validate', { pin });
          const hasilPin = v.data || v.results || {};
          if (/endpoint target/i.test(pesanKA(v))) return res.status(200).json({ ok: false, pesan: 'Endpoint cek PIN tidak tersedia di server KiriminAja ini. Coba kosongkan PIN.' });
          if (v.status !== true || hasilPin.valid === false) {
            const sisa = hasilPin.max_attempt ? ` (percobaan ${hasilPin.attempt}/${hasilPin.max_attempt}${hasilPin.lock_until ? ', terkunci sampai ' + hasilPin.lock_until : ''})` : '';
            return res.status(200).json({ ok: false, pesan: (v.text || 'PIN KA Credit salah.') + sisa });
          }
          kirim.pin = pin;
        }
      }
      // Sandbox kadang belum punya v6.2 ("Unable to find your endpoint target") → coba v6.1
      let jalurPickup = '/api/mitra/v6.2/request_pickup';
      let d = await panggilKA(jalurPickup, kirim);
      if (d.status !== true && /endpoint target/i.test(pesanKA(d))) {
        jalurPickup = '/api/mitra/v6.1/request_pickup';
        d = await panggilKA(jalurPickup, kirim);
      }
      if (d.status === false || d.status === undefined) {
        const kode = d.results && d.results.error;
        const arti = { PIN_INVALID: 'PIN KA Credit salah.', PIN_MAX_ATTEMPT_REACHED: 'PIN salah terlalu sering, akun terkunci sementara.', BALANCE_NOT_ENOUGH: 'Saldo KA Credit tidak cukup. Top up dulu.' };
        return res.status(200).json({ ok: false, pesan: (arti[kode] || pesanKA(d)) + ` [${jalurPickup.replace('/api/mitra/', '')}]`, detail: d.errors || d.details || d.results || null });
      }
      const ubah = {
        ka_order_id: orderId,
        ka_pickup_number: d.pickup_number || d.payment_id || null,
        ka_payment_status: p.metode_bayar === 'COD' ? 'cod' : (pakaiCredit && d.payment_status !== 'unpaid' ? 'paid' : (d.payment_status || null)),
        ka_qr: d.qr_url || d.qr_content || null,
        ka_status: 'Pickup diminta',
        ka_jadwal: b.jadwal,
        resi_kurir: awbDari(d) || p.resi_kurir || null
      };
      await simpanPesanan(p.id, ubah, token);
      return res.status(200).json({ ok: true, pesan: d.text || 'Request pickup berhasil.', ...ubah });
    }

    // ---------- Lacak ----------
    if (b.aksi === 'lacak') {
      if (!p.ka_order_id) return res.status(200).json({ ok: false, pesan: 'Belum request pickup.' });
      const d = await panggilKA('/api/mitra/tracking', { order_id: p.ka_order_id });
      if (d.status === false) return res.status(200).json({ ok: false, pesan: pesanKA(d) });
      const t = rapikanTracking(d);
      const terakhir = t.riwayat.length ? t.riwayat[t.riwayat.length - 1].status : null;
      const ubah = {};
      if (t.awb && t.awb !== p.resi_kurir) ubah.resi_kurir = t.awb;
      const statusBaru = t.terkirim ? 'Terkirim' : (t.dikembalikan ? 'Dikembalikan' : terakhir);
      if (statusBaru && statusBaru !== p.ka_status) ubah.ka_status = statusBaru;
      if (Object.keys(ubah).length) await simpanPesanan(p.id, ubah, token);
      return res.status(200).json({ ok: true, ...t, ...ubah });
    }

    // ---------- Cetak label (PDF resmi KiriminAja) ----------
    if (b.aksi === 'label') {
      let awb = p.resi_kurir;
      if (!awb && p.ka_order_id) {
        const t = rapikanTracking(await panggilKA('/api/mitra/tracking', { order_id: p.ka_order_id }));
        awb = t.awb;
        if (awb) await simpanPesanan(p.id, { resi_kurir: awb }, token);
      }
      if (!awb) return res.status(200).json({ ok: false, pesan: 'Resi (AWB) belum terbit. Untuk non-COD, pastikan ongkir sudah dibayar. Coba klik Lacak beberapa saat lagi.' });
      const d = await panggilKA('/api/mitra/v6.1/awb/print', { awb: [awb] });
      const url = (d.data && (d.data.url || (d.data.data && d.data.data.url))) || d.url;
      if (!url) return res.status(200).json({ ok: false, pesan: pesanKA(d) });
      return res.status(200).json({ ok: true, url, awb });
    }

    // ---------- Batalkan pengiriman ----------
    if (b.aksi === 'batal') {
      if (!p.ka_order_id) return res.status(200).json({ ok: false, pesan: 'Belum ada pengiriman untuk dibatalkan.' });
      if (!p.resi_kurir) {
        // Resi belum ada: pembatalan dilakukan di dashboard/simulasi KiriminAja, lalu data di website cukup direset
        if (!b.paksa) return res.status(200).json({ ok: false, perlu_reset: true, pesan: 'Resi belum terbit, jadi tidak bisa dibatalkan lewat API.' });
        const ubah = {
          ka_status: `Pickup direset (${p.ka_order_id})`,
          ka_order_id: null, ka_pickup_number: null, ka_payment_status: null, ka_qr: null, ka_jadwal: null,
          ka_percobaan: (p.ka_percobaan || 0) + 1
        };
        await simpanPesanan(p.id, ubah, token);
        return res.status(200).json({ ok: true, pesan: 'Data pickup di website direset. Pesanan bisa di-request pickup ulang.', ...ubah });
      }
      const alasan = String(b.alasan || 'Dibatalkan penjual').slice(0, 100);
      const d = await panggilKA('/api/mitra/v3/cancel_shipment', {}, { awb: p.resi_kurir, reason: alasan });
      if (d.status === false || d.status === undefined) return res.status(200).json({ ok: false, pesan: pesanKA(d) });
      const ubah = {
        ka_status: `Pengiriman dibatalkan (${p.ka_order_id})`,
        ka_order_id: null, ka_pickup_number: null, ka_payment_status: null, ka_qr: null, ka_jadwal: null,
        resi_kurir: null, ka_percobaan: (p.ka_percobaan || 0) + 1
      };
      await simpanPesanan(p.id, ubah, token);
      return res.status(200).json({ ok: true, pesan: d.text || 'Pengiriman dibatalkan.', ...ubah });
    }

    // ---------- Cek pembayaran ongkir (non-COD) ----------
    if (b.aksi === 'bayar') {
      if (!p.ka_pickup_number) return res.status(200).json({ ok: false, pesan: 'Tidak ada tagihan ongkir.' });
      const d = await panggilKA('/api/mitra/v2/get_payment', { payment_id: p.ka_pickup_number });
      const data = d.data || d.result || {};
      const lunas = !!data.paid_at || /paid|lunas|success/i.test(String(data.status || '')) && !/unpaid/i.test(String(data.status || ''));
      const ubah = { ka_payment_status: lunas ? 'paid' : (data.status || 'unpaid') };
      if (data.qr_content) ubah.ka_qr = data.qr_content;
      await simpanPesanan(p.id, ubah, token);
      return res.status(200).json({ ok: true, lunas, jumlah: data.amount || null, batas: data.pay_time || null, ...ubah });
    }

    return res.status(400).json({ ok: false, pesan: 'Aksi tidak dikenal.' });
  } catch (e) {
    console.error('api/kiriman error:', e);
    return res.status(500).json({ ok: false, pesan: e.message || 'Terjadi kesalahan di server.' });
  }
};
