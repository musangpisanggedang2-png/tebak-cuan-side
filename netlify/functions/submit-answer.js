// =====================================================================
// netlify/functions/submit-answer.js
// ENDPOINT: /api/submit-answer
// Dipanggil tiap kali user menjawab 1 soal. Tugas: cek jawaban benar/
// salah SECARA RAHASIA (jawaban benar disimpan di server, gak pernah
// dikirim ke HP user), lalu kalau benar, TAMBAH SALDO beneran di database.
// =====================================================================

const { supabase, jsonResponse, handleOptionsPreflight, getUserFromInitData } = require('./_shared');

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

  const { initData, questionId, selectedIndex } = body;
  if (!initData || !questionId || selectedIndex === undefined) {
    return jsonResponse(400, { error: 'initData, questionId, dan selectedIndex wajib dikirim' });
  }

  const result = await getUserFromInitData(initData);
  if (result.error === 'INVALID_INIT_DATA') return jsonResponse(401, { error: 'Data tidak valid' });
  if (result.error === 'USER_NOT_FOUND') return jsonResponse(404, { error: 'User belum terdaftar' });
  if (result.error === 'BANNED') return jsonResponse(403, { error: 'Akun ini diblokir' });
  if (result.error) return jsonResponse(500, { error: 'Gagal mengambil user', detail: result.detail });

  const user = result.user;

  // Ambil soal + jawaban benar (data ini TIDAK PERNAH dikirim ke frontend sebelumnya)
  const { data: question, error: qError } = await supabase
    .from('quiz_questions')
    .select('*')
    .eq('id', questionId)
    .maybeSingle();

  if (qError || !question) {
    return jsonResponse(404, { error: 'Soal tidak ditemukan' });
  }

  const isCorrect = question.correct_index === selectedIndex;

  // Hitung reward pakai pengali membership (kalau ada & aktif)
  let rewardMultiplier = 1.0;
  const membershipActive = user.membership_expires_at && new Date(user.membership_expires_at) > new Date();
  if (membershipActive && user.membership_tier !== 'free') {
    const { data: plan } = await supabase
      .from('membership_plans')
      .select('reward_multiplier')
      .eq('name', user.membership_tier)
      .maybeSingle();
    if (plan) rewardMultiplier = plan.reward_multiplier;
  }

  const rewardGiven = isCorrect ? Math.round(question.base_reward * rewardMultiplier) : 0;

  // Catat percobaan jawaban (buat riwayat & anti-curang)
  const { error: attemptError } = await supabase.from('quiz_attempts').insert({
    user_id: user.id,
    question_id: question.id,
    selected_index: selectedIndex,
    is_correct: isCorrect,
    reward_given: rewardGiven,
  });

  if (attemptError) {
    return jsonResponse(500, { error: 'Gagal mencatat jawaban', detail: attemptError.message });
  }

  let newBalance = user.balance;
  let newDailyCount = user.daily_quiz_count + 1;

  if (isCorrect && rewardGiven > 0) {
    // Catat di buku kas (reward_ledger) SEBELUM update saldo, biar ada jejak
    await supabase.from('reward_ledger').insert({
      user_id: user.id,
      source: 'quiz',
      amount: rewardGiven,
      description: `Jawaban benar soal #${question.id}`,
    });

    newBalance = user.balance + rewardGiven;
  }

  const { error: updateError } = await supabase
    .from('users')
    .update({ balance: newBalance, daily_quiz_count: newDailyCount })
    .eq('id', user.id);

  if (updateError) {
    return jsonResponse(500, { error: 'Gagal update saldo', detail: updateError.message });
  }

  return jsonResponse(200, {
    isCorrect,
    correctIndex: question.correct_index, // dikirim SETELAH dijawab, aman buat kasih tau user
    rewardGiven,
    newBalance,
  });
};
