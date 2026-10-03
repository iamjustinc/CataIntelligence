import { SignOutButton } from "@/components/shell-client";
import { StatePanel } from "@/components/ui";

export const metadata = { title: "No workspace access" };

export default function NoAccess() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-xl">
        <StatePanel kind="denied" title="You are signed in, but not a member of any workspace" action={<SignOutButton />}>
          Ask a workspace administrator to add you. Access is granted per workspace; a role in one workspace never applies to another.
        </StatePanel>
      </div>
    </main>
  );
}
