export type OnboardingProject = {
  projectId: string;
  legacyEndpoint: string;
  adapterTools: string[];
  status: "registered" | "migrating" | "pilot_live";
  createdAt: string;
};

export class ProjectOnboardingService {
  private readonly projects = new Map<string, OnboardingProject>();

  register(input: {
    projectId: string;
    legacyEndpoint: string;
    adapterTools: string[];
    status?: OnboardingProject["status"];
  }): OnboardingProject {
    const project: OnboardingProject = {
      projectId: input.projectId,
      legacyEndpoint: input.legacyEndpoint,
      adapterTools: input.adapterTools,
      status: input.status ?? "registered",
      createdAt: new Date().toISOString()
    };
    this.projects.set(input.projectId, project);
    return project;
  }

  list(): OnboardingProject[] {
    return [...this.projects.values()];
  }

  get(projectId: string): OnboardingProject | undefined {
    return this.projects.get(projectId);
  }

  markStatus(projectId: string, status: OnboardingProject["status"]): OnboardingProject | undefined {
    const existing = this.projects.get(projectId);
    if (!existing) {
      return undefined;
    }
    existing.status = status;
    this.projects.set(projectId, existing);
    return existing;
  }
}
