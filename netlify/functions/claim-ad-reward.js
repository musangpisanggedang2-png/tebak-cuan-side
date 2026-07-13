// =====================================================================
// netlify/functions/claim-ad-reward.js
// ENDPOINT: /api/claim-ad-reward
// Dipanggil SETELAH AdsGram konfirmasi user nonton video sampai selesai.
// Tugas: kasih bonus saldo tambahan, dan catat biar gak bisa diklaim
// berkali-kali dalam waktu singkat (anti-curang sederhana).
// =====================================================================

const { supabase, jsonResponse, handleOptionsPreflight, getUserFromInitData } = require('./_shared');

const AD_REWARD_AMOUNT = 50; // bonus koin per video ditonton, bisa diubah
const COOLDOWN_SECONDS = 30; // jarak minimal antar klaim, cegah spam klik

exports.handler = async (event) => {
  const preflight = handleOptionsPreflight(event);
  if (preflight) return preflight;

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return jsonResponse(400, { error: 'Body request tidak valid' });
  }

  const { initData, blockId } = body;
  if (!initData) {
    return jsonResponse(400, { error: 'initData wajib dikirim' });
  }

  const result = await getUserFromInitData(initData);
  if (result.error === 'INVALID_INIT_DATA') return jsonResponse(401, { error: 'Data tidak valid' });
  if (result.error === 'USER_NOT_FOUND') return jsonResponse(404, { error: 'User belum terdaftar' });
  if (result.error === 'BANNED') return jsonResponse(403, { error: 'Akun ini diblokir' });
  if (result.error) return jsonResponse(500, { error: 'Gagal mengambil user', detail: result.detail });

  const user = result.user;

  // Anti-spam: cek klaim terakhir user, tolak kalau kurang dari COOLDOWN_SECONDS
  const { data: lastView } = await supabase
    .from('ad_views')
    .select('viewed_at')
    .eq('user_id', user.id)
    .order('viewed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastView) {
    const secondsSinceLastClaim = (Date.now() - new Date(lastView.viewed_at).getTime()) / 1000;
    if (secondsSinceLastClaim < COOLDOWN_SECONDS) {
      return jsonResponse(429, { error: 'Terlalu cepat, tunggu sebentar sebelum klaim lagi' });
    }
  }

  const { error: viewError } = await supabase.from('ad_views').insert({
    user_id: user.id,
    block_id: blockId || 'unknown',
    reward_amount: AD_REWARD_AMOUNT,
  });

  if (viewError) {
    return jsonResponse(500, { error: 'Gagal mencatat tayangan iklan', detail: viewError.message });
  }

  await supabase.from('reward_ledger').insert({
    user_id: user.id,
    source: 'ads_reward',
    amount: AD_REWARD_AMOUNT,
    description: 'Bonus nonton rewarded video',
  });

  const newBalance = user.balance + AD_REWARD_AMOUNT;

  const { error: updateError } = await supabase
    .from('users')
    .update({ balance: newBalance })
    .eq('id', user.id);

  if (updateError) {
    return jsonResponse(500, { error: 'Gagal update saldo', detail: updateError.message });
  }

  return jsonResponse(200, { rewardGiven: AD_REWARD_AMOUNT, newBalance });
};
