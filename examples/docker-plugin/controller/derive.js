// Pure derivations over a listing: filtering, stats merging, compose grouping
// and tab counts. No hooks and no client, so the panel's data shaping is
// testable on its own.

/** A substring matcher over a row's searchable fields. */
export const matcher = (query) => {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) {
    return () => true;
  }
  return (values) => values.some((value) => String(value ?? "").toLowerCase().includes(needle));
};

/**
 * `docker stats` reports the id it was given, which can be short or full;
 * indexing both forms lets a row find its sample either way.
 */
export const indexStats = (stats) => {
  const map = new Map();
  for (const row of stats || []) {
    map.set(row.id, row);
    map.set(row.id.slice(0, 12), row);
  }
  return map;
};

const withStats = (container, statsById) => ({
  ...container,
  stats: statsById.get(container.id) || statsById.get(container.shortId) || null,
});

export function filterContainers(containers, { stateFilter, query, statsById }) {
  const matches = matcher(query);
  return (containers || [])
    .filter((container) => {
      if (stateFilter === "running") return container.running;
      if (stateFilter === "stopped") return !container.running && !container.paused;
      if (stateFilter === "paused") return container.paused;
      return true;
    })
    .filter((container) =>
      matches([
        container.name,
        container.image,
        container.shortId,
        container.status,
        container.ports,
        container.composeProject,
        container.composeService,
      ]),
    )
    .map((container) => withStats(container, statsById));
}

export const filterImages = (images, query) => {
  const matches = matcher(query);
  return (images || []).filter((image) =>
    matches([image.reference, image.shortId, image.tag, image.repository, image.digest]),
  );
};

export const filterVolumes = (volumes, query) => {
  const matches = matcher(query);
  return (volumes || []).filter((volume) =>
    matches([volume.name, volume.driver, volume.mountpoint]),
  );
};

export const filterNetworks = (networks, query) => {
  const matches = matcher(query);
  return (networks || []).filter((network) =>
    matches([network.name, network.driver, network.scope, network.shortId]),
  );
};

export const filterEvents = (events, query) => {
  const matches = matcher(query);
  return (events || []).filter((event) =>
    matches([event.type, event.action, event.name, event.image, event.id]),
  );
};

/**
 * Compose projects, merged from two sources: the containers' own compose labels
 * (authoritative for what is running, and where the compose files are) and
 * `docker compose ls` (which adds projects with no containers left).
 */
export function groupComposeProjects({ containers, composeProjects, query, statsById }) {
  const byName = new Map();

  for (const container of containers || []) {
    if (!container.composeProject) {
      continue;
    }
    const entry =
      byName.get(container.composeProject) ||
      { name: container.composeProject, files: [], workingDir: "", status: "", services: [] };
    if (entry.files.length === 0 && container.composeFiles.length > 0) {
      entry.files = container.composeFiles;
    }
    if (!entry.workingDir && container.composeWorkingDir) {
      entry.workingDir = container.composeWorkingDir;
    }
    entry.services.push(container);
    byName.set(entry.name, entry);
  }

  for (const project of composeProjects || []) {
    const entry =
      byName.get(project.name) ||
      { name: project.name, files: project.files, workingDir: "", status: "", services: [] };
    entry.status = project.status || entry.status;
    if (entry.files.length === 0) {
      entry.files = project.files;
    }
    byName.set(entry.name, entry);
  }

  const matches = matcher(query);
  return [...byName.values()]
    .filter((project) =>
      matches([project.name, ...project.services.map((service) => service.composeService)]),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((project) => ({
      ...project,
      services: project.services
        .slice()
        .sort((a, b) => a.composeService.localeCompare(b.composeService))
        .map((container) => withStats(container, statsById)),
      running: project.services.filter((service) => service.running).length,
    }));
}

export const countAll = ({ containers, images, volumes, networks, projects, events }) => ({
  containers: containers.length,
  running: containers.filter((container) => container.running).length,
  images: images.length,
  volumes: volumes.length,
  networks: networks.length,
  compose: projects.length,
  events: events.length,
});
