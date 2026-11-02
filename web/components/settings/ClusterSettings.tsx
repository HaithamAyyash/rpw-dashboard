"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { apiGet, apiSend, type ClusterHead } from "@/lib/ui/api";
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
import {
  Card,
  Field,
  FormError,
  optionalNumber,
  optionalText,
  ShowOnce,
} from "./parts";

export function ClusterSettings() {
  const org = useCurrentOrg();
  const client = useQueryClient();
  const base = `/orgs/${org.org_id}/clusters`;
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(
    null,
  );
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["clusters", org.org_id] });

  const clusters = useQuery({
    queryKey: ["clusters", org.org_id],
    queryFn: () => apiGet<{ items: ClusterHead[] }>(base),
  });
  const create = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      apiSend<{ name: string; api_key: string }>("POST", base, values),
    onSuccess: (result) => {
      setNewKey({ name: result.name, key: result.api_key });
      refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: (cluster: ClusterHead) =>
      apiSend<{ api_key: string }>(
        "POST",
        `${base}/${cluster.cluster_id}/rotate-key`,
      ).then((result) => ({
        name: cluster.name,
        key: result.api_key,
      })),
    onSuccess: (result) => {
      setNewKey(result);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiSend("POST", `${base}/${id}/revoke`),
    onSuccess: refresh,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    create.mutate(
      {
        name: String(form.get("name")),
        farm_zone: optionalText(form.get("zone")),
        location_lat: optionalNumber(form.get("lat")),
        location_lon: optionalNumber(form.get("lon")),
        uplink_type: optionalText(form.get("uplink")),
      },
      { onSuccess: () => element.reset() },
    );
  }

  return (
    <Card
      title="Cluster heads"
      note="Each Raspberry Pi has its own API key. Only a hash is stored, so a lost key can only be replaced."
    >
      {newKey && (
        <ShowOnce
          title={`API key for ${newKey.name}`}
          warning="Store this on the Pi now. It won't be shown again."
          value={newKey.key}
          testId="api-key"
          onDone={() => setNewKey(null)}
        />
      )}
      {clusters.isError && (
        <ErrorState
          what="the cluster heads"
          onRetry={() => clusters.refetch()}
        />
      )}
      {clusters.data?.items.length === 0 && (
        <EmptyState>No cluster heads yet.</EmptyState>
      )}
      {clusters.data && clusters.data.items.length > 0 && (
        <div className={tableWrap}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thClass}>Name</th>
                <th className={thClass}>Zone</th>
                <th className={thClass}>Nodes</th>
                <th className={thClass}>Key created</th>
                <th className={thClass}>Status</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody>
              {clusters.data.items.map((cluster) => (
                <tr key={cluster.cluster_id} data-testid="cluster-row">
                  <td className={`${tdClass} font-mono text-text-1`}>
                    {cluster.name}
                  </td>
                  <td className={tdClass}>{cluster.farm_zone ?? "—"}</td>
                  <td className={`${tdClass} font-mono`}>
                    {cluster.node_count}
                  </td>
                  <td
                    className={`${tdClass} font-mono text-[11px] whitespace-nowrap`}
                  >
                    {formatDateTime(cluster.api_key_created_at, org.timezone)}
                  </td>
                  <td className={tdClass}>
                    {cluster.revoked ? "Revoked" : "Active"}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap text-right`}>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Replace the key for ${cluster.name}? The Pi stops sending until it has the new one.`,
                          )
                        )
                          rotate.mutate(cluster);
                      }}
                      className={ghostButton}
                    >
                      Rotate key
                    </button>{" "}
                    {!cluster.revoked && (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Revoke ${cluster.name}? Its key stops working at once.`,
                            )
                          )
                            revoke.mutate(cluster.cluster_id);
                        }}
                        className={ghostButton}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormError error={rotate.error ?? revoke.error} />

      <form
        onSubmit={submit}
        className="mt-4 grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-6"
      >
        <Field label="Name">
          <input
            name="name"
            required
            placeholder="CH-03"
            className={inputClass}
          />
        </Field>
        <Field label="Zone">
          <input name="zone" placeholder="Zone A" className={inputClass} />
        </Field>
        <Field label="Latitude">
          <input
            name="lat"
            type="number"
            step="any"
            min="-90"
            max="90"
            className={inputClass}
          />
        </Field>
        <Field label="Longitude">
          <input
            name="lon"
            type="number"
            step="any"
            min="-180"
            max="180"
            className={inputClass}
          />
        </Field>
        <Field label="Uplink">
          <select name="uplink" className={inputClass}>
            <option value="">Not set</option>
            <option value="wifi">Wi-Fi</option>
            <option value="4g">4G</option>
          </select>
        </Field>
        <button
          type="submit"
          disabled={create.isPending}
          className={primaryButton}
        >
          Register
        </button>
      </form>
      <FormError error={create.error} />
    </Card>
  );
}
