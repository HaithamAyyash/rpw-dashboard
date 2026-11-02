"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiSend, type OrgSettings } from "@/lib/ui/api";
import { useCurrentOrg } from "../OrgContext";
import { ErrorState, inputClass, primaryButton } from "../States";
import { useOrgSettings } from "../useOrgSettings";
import { Card, Field, FormError } from "./parts";

const TIME_ZONES =
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : [];

export function OrganizationSettings() {
  const org = useCurrentOrg();
  const settings = useOrgSettings();
  const client = useQueryClient();
  const router = useRouter();
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (values: Partial<OrgSettings>) =>
      apiSend<OrgSettings>("PATCH", `/orgs/${org.org_id}`, values),
    onSuccess: async () => {
      setSaved(true);
      await client.invalidateQueries();
      router.refresh(); // the name and time zone also appear in the top bar
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    const form = new FormData(event.currentTarget);
    save.mutate({
      name: String(form.get("name")),
      timezone: String(form.get("timezone")),
      suspect_threshold: Number(form.get("suspect")) / 100,
      alert_threshold: Number(form.get("alert")) / 100,
    });
  }

  return (
    <Card
      title="Organization"
      note="Thresholds apply to the last-3 average of each tree."
    >
      {settings.isError && (
        <ErrorState what="the settings" onRetry={() => settings.refetch()} />
      )}
      {settings.isPending && (
        <div className="h-24 animate-pulse rounded-md bg-white/5" />
      )}
      {settings.data && (
        <form
          key={settings.dataUpdatedAt}
          onSubmit={submit}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        >
          <Field label="Name">
            <input
              name="name"
              required
              defaultValue={settings.data.name}
              className={inputClass}
            />
          </Field>
          <Field label="Time zone">
            <input
              name="timezone"
              required
              list="time-zones"
              defaultValue={settings.data.timezone}
              className={inputClass}
            />
            <datalist id="time-zones">
              {TIME_ZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </Field>
          <Field label="Suspected from (%)">
            <input
              name="suspect"
              type="number"
              min="0"
              max="100"
              step="0.1"
              required
              defaultValue={
                Math.round(settings.data.suspect_threshold * 1000) / 10
              }
              className={inputClass}
            />
          </Field>
          <Field label="Alert from (%)">
            <input
              name="alert"
              type="number"
              min="0"
              max="100"
              step="0.1"
              required
              defaultValue={
                Math.round(settings.data.alert_threshold * 1000) / 10
              }
              className={inputClass}
            />
          </Field>
          <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
            <button
              type="submit"
              disabled={save.isPending}
              className={primaryButton}
            >
              Save
            </button>
            {saved && !save.isError && (
              <span className="text-[12px] text-accent">Saved</span>
            )}
          </div>
        </form>
      )}
      <FormError error={save.error} />
    </Card>
  );
}
