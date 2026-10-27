import { RecordPaymentButton } from "~/components/payments";
export default function ReceiptModal() {
  return <dialog open><RecordPaymentButton bookingId="receipt" /></dialog>;
}
