import { RecordPaymentButton } from "../../../../components/payments/record-payment-button";
export default function Booking({ params }: { params: { id: string } }) {
  return <RecordPaymentButton bookingId={params.id} />;
}
