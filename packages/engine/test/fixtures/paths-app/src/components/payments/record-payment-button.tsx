"use client";
export function RecordPaymentButton({ bookingId }: { bookingId: string }) {
  async function save() {
    await fetch("/api/payments", {
      method: "POST",
      body: JSON.stringify({ bookingId }),
    });
  }
  return <button onClick={save}>Record payment</button>;
}
