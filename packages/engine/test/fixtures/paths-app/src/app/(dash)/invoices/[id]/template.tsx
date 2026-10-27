import { RecordPaymentButton } from "@/components/payments/record-payment-button.js";
export default function InvoiceTemplate({ children }: { children: React.ReactNode }) {
  return <>{children}<RecordPaymentButton bookingId="invoice" /></>;
}
