// =====================================================================
// netlify/functions/auth.js
// Versi Netlify Functions dari fungsi login Telegram.
// Fungsi ini jadi "penjaga pintu": tiap kali mini app dibuka, frontend
// kirim data dari Telegram ke sini. Fungsi ini MEMASTIKAN data itu asli
// dari Telegram (bukan orang iseng ngaku-ngaku jadi user lain), lalu
// bikin/update baris user di database.
// =====================================================================

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Environment variables ini diisi nanti di Netlify: Site settings ->
// Environment variables (BUKAN ditulis langsung di kode)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function verifyTelegramInitData(initData) {
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const dataCheckArr = [];
  for (const [key, value] of [...urlParams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) {
    return null;
  }

  const userJson = urlParams.get('user');
  if (!userJson) return null;

  return {
    user: JSON.parse(userJson),
    startParam: urlParams.get('start_param') || null,
  };
}

function generateReferralCode() {
  return 'RF' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function needsDailyReset(dailyResetDate) {
  const today = new Date().toISOString().slice(0, 10);
  return dailyResetDate !== today;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Body request tidak valid' }) };
  }

  const { initData } = body;
  if (!initData) {
    return { statusCode: 400, body: JSON.stringify({ error: 'initData wajib dikirim' }) };
  }

  const verified = verifyTelegramInitData(initData);
  if (!verified) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Data tidak valid, bukan dari Telegram asli' }) };
  }

  const tgUser = verified.user;

  let { data: existingUser, error: findError } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', tgUser.id)
    .maybeSingle();

  if (findError) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Gagal mengambil data user', detail: findError.message }) };
  }

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
      return { statusCode: 500, body: JSON.stringify({ error: 'Gagal membuat user baru', detail: insertError.message }) };
    }

    if (newUserPayload.referred_by) {
      await supabase.from('referrals').insert({
        referrer_id: newUserPayload.referred_by,
        referred_id: createdUser.id,
        bonus_amount: 0,
      });
    }

    return { statusCode: 200, body: JSON.stringify({ user: createdUser, isNewUser: true }) };
  }

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
      return { statusCode: 500, body: JSON.stringify({ error: 'Gagal reset kuota harian', detail: updateError.message }) };
    }
    existingUser = updatedUser;
  }

  if (existingUser.is_banned) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Akun ini diblokir' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ user: existingUser, isNewUser: false }) };
};
