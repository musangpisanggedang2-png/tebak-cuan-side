// =====================================================================
// netlify/functions/auth.js
// ENDPOINT: /api/auth
// Dipanggil SEKALI saat mini app (Site 1) pertama kali dibuka.
// Tugas: pastikan data dari Telegram asli, lalu buat/ambil akun user.
// =====================================================================

const crypto = require('crypto');
const {
  supabase,
  jsonResponse,
  handleOptionsPreflight,
  verifyTelegramInitData,
  needsDailyReset,
} = require('./_shared');

function generateReferralCode() {
  return 'RF' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

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

  const { initData } = body;
  if (!initData) {
    return jsonResponse(400, { error: 'initData wajib dikirim' });
  }

  const verified = verifyTelegramInitData(initData);
  if (!verified) {
    return jsonResponse(401, { error: 'Data tidak valid, bukan dari Telegram asli' });
  }

  const tgUser = verified.user;

  let { data: existingUser, error: findError } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', tgUser.id)
    .maybeSingle();

  if (findError) {
    return jsonResponse(500, { error: 'Gagal mengambil data user', detail: findError.message });
  }

  // ---------------- USER BARU ----------------
  if (!existingUser) {
    const newUserPayload = {
      telegram_id: tgUser.id,
      username: tgUser.username || null,
      first_name: tgUser.first_name || null,
      referral_code: generateReferralCode(),
    };

    if (verified.startParam) {
      const { data: referrer } = await supabase
        .from('users')
        .select('id')
        .eq('referral_code', verified.startParam)
        .maybeSingle();

      if (referrer) {
        newUserPayload.referred_by = referrer.id;
      }
    }

    const { data: createdUser, error: insertError } = await supabase
      .from('users')
      .insert(newUserPayload)
      .select()
      .single();

    if (insertError) {
      return jsonResponse(500, { error: 'Gagal membuat user baru', detail: insertError.message });
    }

    if (newUserPayload.referred_by) {
      await supabase.from('referrals').insert({
        referrer_id: newUserPayload.referred_by,
        referred_id: createdUser.id,
        bonus_amount: 0,
      });
    }

    return jsonResponse(200, { user: createdUser, isNewUser: true });
  }

  // ---------------- USER LAMA ----------------
  if (needsDailyReset(existingUser.daily_quiz_reset_at)) {
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({
        daily_quiz_count: 0,
        daily_quiz_reset_at: new Date().toISOString().slice(0, 10),
      })
      .eq('id', existingUser.id)
      .select()
      .single();

    if (updateError) {
      return jsonResponse(500, { error: 'Gagal reset kuota harian', detail: updateError.message });
    }
    existingUser = updatedUser;
  }

  if (existingUser.is_banned) {
    return jsonResponse(403, { error: 'Akun ini diblokir' });
  }

  return jsonResponse(200, { user: existingUser, isNewUser: false });
};
