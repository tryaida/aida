export default function DashboardLayout({ children, quickpay }: { children: React.ReactNode; quickpay: React.ReactNode }) {
  return <div>{children}{quickpay}</div>;
}
