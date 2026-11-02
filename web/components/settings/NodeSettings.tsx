"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState, type ChangeEvent, type FormEvent } from "react";
import {
  apiGet,
  apiSend,
  type ClusterHead,
  type Page,
  type SettingsNode,
} from "@/lib/ui/api";
import { useCurrentOrg } from "../OrgContext";
import {
  EmptyState,
  ErrorState,
  ghostButton,
  inputClass,
  Pager,
  primaryButton,
  tableWrap,
  tdClass,
  thClass,
} from "../States";
import { Card, Field, FormError, optionalNumber, optionalText } from "./parts";

const PAGE_SIZE = 25;

function NodeForm({
  node,
  clusters,
  busy,
  label,
  onSubmit,
  onCancel,
}: {
  node?: SettingsNode;
  clusters: ClusterHead[];
  busy: boolean;
  label: string;
  onSubmit: (values: Record<string, unknown>, form: HTMLFormElement) => void;
  onCancel?: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit(
      {
        lora_id: Number(form.get("lora")),
        tree_label: String(form.get("label")),
        cluster_id: String(form.get("cluster")),
        farm_zone: optionalText(form.get("zone")) ?? null,
        location_lat: optionalNumber(form.get("lat")) ?? null,
        location_lon: optionalNumber(form.get("lon")) ?? null,
      },
      event.currentTarget,
    );
  }
  return (
    <form
      onSubmit={submit}
      className="grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-7"
    >
      <Field label="LoRa ID">
        <input
          name="lora"
          type="number"
          min="0"
          max="255"
          required
          defaultValue={node?.lora_id}
          className={inputClass}
        />
      </Field>
      <Field label="Tree label">
        <input
          name="label"
          required
          defaultValue={node?.tree_label}
          className={inputClass}
        />
      </Field>
      <Field label="Cluster head">
        <select
          name="cluster"
          required
          defaultValue={node?.cluster_id}
          className={inputClass}
        >
          {clusters.map((c) => (
            <option key={c.cluster_id} value={c.cluster_id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Zone">
        <input
          name="zone"
          defaultValue={node?.farm_zone ?? ""}
          className={inputClass}
        />
      </Field>
      <Field label="Latitude">
        <input
          name="lat"
          type="number"
          step="any"
          min="-90"
          max="90"
          defaultValue={node?.location_lat ?? ""}
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
          defaultValue={node?.location_lon ?? ""}
          className={inputClass}
        />
      </Field>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {label}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={ghostButton}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function NodeSettings() {
  const org = useCurrentOrg();
  const client = useQueryClient();
  const base = `/orgs/${org.org_id}/nodes`;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const refresh = () => client.invalidateQueries();

  const nodes = useQuery({
    queryKey: ["settings-nodes", org.org_id, search, page],
    queryFn: () =>
      apiGet<Page<SettingsNode>>(base, {
        q: search,
        page,
        page_size: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
  });
  const clusters = useQuery({
    queryKey: ["clusters", org.org_id],
    queryFn: () =>
      apiGet<{ items: ClusterHead[] }>(`/orgs/${org.org_id}/clusters`),
  });

  const create = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      apiSend("POST", base, values),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: ({
      id,
      values,
    }: {
      id: number;
      values: Record<string, unknown>;
    }) => apiSend("PATCH", `${base}/${id}`, values),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const importCsv = useMutation({
    mutationFn: (csv: string) =>
      apiSend<{ imported: number }>("POST", `${base}/import`, { csv }),
    onSuccess: (result) => {
      setImported(result.imported);
      refresh();
    },
  });

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    setImported(null);
    if (file) importCsv.mutate(await file.text());
  }

  const clusterList = clusters.data?.items ?? [];

  return (
    <Card
      title="Nodes"
      note="One per tree. A LoRa ID must be unique among the active nodes of a cluster head."
    >
      <input
        type="search"
        aria-label="Search nodes"
        placeholder="Search label or LoRa ID"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setPage(1);
        }}
        className={`${inputClass} mb-3 w-56`}
      />
      {nodes.isError && (
        <ErrorState what="the nodes" onRetry={() => nodes.refetch()} />
      )}
      {nodes.data?.items.length === 0 && (
        <EmptyState>{search ? "No nodes match." : "No nodes yet."}</EmptyState>
      )}
      {nodes.data && nodes.data.items.length > 0 && (
        <div className={tableWrap}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={thClass}>Tree</th>
                <th className={thClass}>LoRa ID</th>
                <th className={thClass}>Cluster head</th>
                <th className={thClass}>Zone</th>
                <th className={thClass}>Coordinates</th>
                <th className={thClass}>State</th>
                <th className={thClass} />
              </tr>
            </thead>
            <tbody>
              {nodes.data.items.map((node) =>
                editing === node.node_id ? (
                  <tr key={node.node_id}>
                    <td colSpan={7} className={tdClass}>
                      <NodeForm
                        node={node}
                        clusters={clusterList}
                        busy={update.isPending}
                        label="Save"
                        onSubmit={(values) =>
                          update.mutate({ id: node.node_id, values })
                        }
                        onCancel={() => setEditing(null)}
                      />
                      <FormError error={update.error} />
                    </td>
                  </tr>
                ) : (
                  <tr key={node.node_id} data-testid="node-row">
                    <td
                      className={`${tdClass} font-mono whitespace-nowrap text-text-1`}
                    >
                      {node.tree_label}
                    </td>
                    <td className={`${tdClass} font-mono`}>{node.lora_id}</td>
                    <td className={`${tdClass} font-mono`}>
                      {node.cluster_name}
                    </td>
                    <td className={tdClass}>{node.farm_zone ?? "—"}</td>
                    <td
                      className={`${tdClass} font-mono text-[11px] whitespace-nowrap`}
                    >
                      {node.location_lat === null
                        ? "—"
                        : `${node.location_lat}, ${node.location_lon}`}
                    </td>
                    <td className={tdClass}>
                      {node.active ? "Active" : "Retired"}
                    </td>
                    <td className={`${tdClass} whitespace-nowrap text-right`}>
                      <button
                        type="button"
                        onClick={() => setEditing(node.node_id)}
                        className={ghostButton}
                      >
                        Edit
                      </button>{" "}
                      <button
                        type="button"
                        onClick={() =>
                          update.mutate({
                            id: node.node_id,
                            values: { active: !node.active },
                          })
                        }
                        className={ghostButton}
                      >
                        {node.active ? "Retire" : "Restore"}
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      {editing === null && <FormError error={update.error} />}
      <Pager
        page={page}
        pageSize={PAGE_SIZE}
        total={nodes.data?.total}
        onPage={setPage}
      />

      <h3 className="mt-5 mb-2 text-[12px] font-medium text-text-1">
        Add a node
      </h3>
      {clusterList.length === 0 ? (
        <p className="text-[12px] text-text-3">
          Register a cluster head first.
        </p>
      ) : (
        <NodeForm
          clusters={clusterList}
          busy={create.isPending}
          label="Add node"
          onSubmit={(values, form) =>
            create.mutate(values, { onSuccess: () => form.reset() })
          }
        />
      )}
      <FormError error={create.error} />

      <h3 className="mt-5 mb-1 text-[12px] font-medium text-text-1">
        Import from CSV
      </h3>
      <p className="mb-2 text-[12px] text-text-3">
        Columns: <code className="font-mono">lora_id, tree_label, cluster</code>
        , plus optional{" "}
        <code className="font-mono">farm_zone, location_lat, location_lon</code>
        . If any row is bad, nothing is imported.
      </p>
      <label className={`${ghostButton} inline-block cursor-pointer`}>
        Choose a CSV file
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file to import"
          onChange={chooseFile}
          className="sr-only"
        />
      </label>
      {importCsv.isPending && (
        <span className="ml-2 text-[12px] text-text-3">Importing…</span>
      )}
      {imported !== null && (
        <span className="ml-2 text-[12px] text-accent">
          Imported {imported} nodes
        </span>
      )}
      <FormError error={importCsv.error} />
    </Card>
  );
}
