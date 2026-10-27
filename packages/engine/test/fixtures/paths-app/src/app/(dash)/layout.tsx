import { Button } from "@/components";
export default function DashLayout({ children }: { children: React.ReactNode }) {
  return <div><nav><Button>Menu</Button></nav>{children}</div>;
}
