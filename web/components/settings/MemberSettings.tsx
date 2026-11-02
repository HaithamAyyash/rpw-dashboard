"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { apiGet, apiSend, type Invite, type Member } from "@/lib/ui/api";
import { formatDateTime } from "@/lib/ui/format";
import { useCurrentOrg } from "../OrgContext";
import {
  EmptyState,
  ErrorState,
  ghostButton,
  inputClass,
  primaryButton,
  tableWrap,
  tdClass,
  thClass,
} from "../States";
import { Card, FormError, ShowOnce } from "./parts";

type Created = { link: string; email_sent: boolean };

export function MemberSettings() {
  const org = useCurrentOrg();
  const client = useQueryClient();
  const [created, setCreated] = useState<(Created & { email: string }) | null>(
    null,
  );
  const base = `/orgs/${org.org_id}`;
  const refresh = () => {
    client.invalidateQueries({ queryKey: ["members", org.org_id] });
    client.invalidateQueries({ queryKey: ["invites", org.org_id] });
  };

  const members = useQuery({
    queryKey: ["members", org.org_id],
    queryFn: () => apiGet<{ items: Member[]; you: string }>(`${base}/members`),
  });
  const invites = useQuery({
    queryKey: ["invites", org.org_id],
    queryFn: () => apiGet<{ items: Invite[] }>(`${base}/invites`),
  });

  const invite = useMutation({
    mutationFn: (email: string) =>
      apiSend<Created>("POST", `${base}/invites`, { email }).then((result) => ({
        ...result,
        email,
      })),
    onSuccess: (result) => {
      setCreated(result);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      apiSend("DELETE", `${base}/members/${userId}`),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: (inviteId: string) =>
      apiSend("DELETE", `${base}/invites/${inviteId}`),
    onSuccess: refresh,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    invite.mutate(String(new FormData(formElement).get("email")), {
      onSuccess: () => formElement.reset(),
    });
  }

  return (
    <Card title="Members" note="Owners can do everything in this organization.">
      {created && (
        <ShowOnce
          title={`Invite created for ${created.email}`}
          warning={
            created.email_sent
              ? "We've emailed this link. It works once and expires in 7 days; it won't be shown again."
              : "The email couldn't be sent, so share this link yourself. It works once and expires in 7 days; it won't be shown again."
          }
          value={created.link}
          testId="invite-link"
          onDone={() => setCreated(null)}
        />
      )}
      {members.isError && (
        <ErrorState what="the members" onRetry={() => members.refetch()} />
      )}
      {members.data && (
        <div className={tableWrap}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thClass}>Name</th>
                <th className={thClass}>Email</th>
                <th className={thClass}>Role</th>
                <th className={thClass}>Last login</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody>
              {members.data.items.map((member) => (
                <tr key={member.user_id} data-testid="member-row">
                  <td className={`${tdClass} text-text-1`}>
                    {member.name}
                    {member.user_id === members.data.you ? " (you)" : ""}
                  </td>
                  <td className={tdClass}>{member.email}</td>
                  <td className={`${tdClass} capitalize`}>{member.role}</td>
                  <td
                    className={`${tdClass} font-mono text-[11px] whitespace-nowrap`}
                  >
                    {member.last_login
                      ? formatDateTime(member.last_login, org.timezone)
                      : "Never"}
                  </td>
                  <td className={`${tdClass} text-right`}>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove ${member.name} from ${org.name}?`,
                          )
                        )
                          remove.mutate(member.user_id);
                      }}
                      className={ghostButton}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormError error={remove.error} />

      <form onSubmit={submit} className="mt-4 flex flex-wrap gap-2">
        <input
          name="email"
          type="email"
          required
          aria-label="Email to invite"
          placeholder="name@example.com"
          className={`${inputClass} w-64`}
        />
        <button
          type="submit"
          disabled={invite.isPending}
          className={primaryButton}
        >
          Invite by email
        </button>
      </form>
      <FormError error={invite.error} />

      <h3 className="mt-5 mb-2 text-[12px] font-medium text-text-1">
        Open invites
      </h3>
      {invites.isError && (
        <ErrorState what="the invites" onRetry={() => invites.refetch()} />
      )}
      {invites.data?.items.length === 0 && (
        <EmptyState>No open invites.</EmptyState>
      )}
      {invites.data?.items.map((item) => (
        <div
          key={item.invite_id}
          className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.04] py-1.5 text-[12px] text-text-2"
        >
          <span>
            {item.email}{" "}
            <span className="text-text-3">
              · expires {formatDateTime(item.expires_at, org.timezone)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => cancel.mutate(item.invite_id)}
            className={ghostButton}
          >
            Cancel
          </button>
        </div>
      ))}
    </Card>
  );
}
