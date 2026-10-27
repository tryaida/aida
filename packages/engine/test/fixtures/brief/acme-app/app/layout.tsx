export const metadata = {
  title: { default: "Acme Events", template: "%s | Acme Events" },
  description: "Book seats at community events.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
