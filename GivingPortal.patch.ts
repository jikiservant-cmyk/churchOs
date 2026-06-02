// ============================================================
// PATCH: GivingPortal.tsx — add this function and call it from
// your submit / give button handler
// ============================================================
//
// Replace or update your existing payment call with this:

const handleGive = async () => {
  setLoading(true);
  setError(null);

  try {
    const res = await fetch('/api/payments/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phoneNumber: normalizeUgPhone(phone), // already imported in your file
        amount: Number(amount),               // must be a number, not a string
        description: `${giveType} - ${church.name}`,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      setError(data.error || 'Payment failed. Please try again.');
      return;
    }

    // STK push sent! Show pending/confirmation state
    setStatus('pending');
    // e.g. setStep('confirmation') depending on your flow

  } catch (err) {
    setError('Network error. Please check your connection.');
  } finally {
    setLoading(false);
  }
};
