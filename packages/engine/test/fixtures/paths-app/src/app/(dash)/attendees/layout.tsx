import { RecordPaymentButton } from "@/components";
export default function AttendeesLayout({ children }: { children: React.ReactNode }) {
  return <div><aside><RecordPaymentButton bookingId="current" /></aside>{children}</div>;
}
