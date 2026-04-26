/**
 * Template registry — builds all IDocTemplate instances for a pipeline run.
 */

import type { IDocTemplate } from '@oweibo/core-contracts';
import type { AnalysisOptions } from '../../analysis/CodebaseAnalyzer.js';
import { ArchitectureDocTemplate }   from './ArchitectureDocTemplate.js';
import { ApiReferenceDocTemplate }   from './ApiReferenceDocTemplate.js';
import { DeveloperGuideDocTemplate } from './DeveloperGuideDocTemplate.js';
import { ModuleReferenceDocTemplate } from './ModuleReferenceDocTemplate.js';
import { DataModelDocTemplate }      from './DataModelDocTemplate.js';
import { EventCatalogueDocTemplate } from './EventCatalogueDocTemplate.js';
import { ADRDocTemplate }            from './ADRDocTemplate.js';
import { DependencyMapDocTemplate }  from './DependencyMapDocTemplate.js';
import { GettingStartedDocTemplate } from './GettingStartedDocTemplate.js';
import { GlossaryDocTemplate }       from './GlossaryDocTemplate.js';
import { ChangelogDocTemplate }      from './ChangelogDocTemplate.js';

export function buildAllTemplates(opts?: Partial<AnalysisOptions>): readonly IDocTemplate[] {
  return [
    new ArchitectureDocTemplate(),
    new ApiReferenceDocTemplate(),
    new DeveloperGuideDocTemplate(),
    new ModuleReferenceDocTemplate(),
    new DataModelDocTemplate(),
    new EventCatalogueDocTemplate(),
    new ADRDocTemplate(),
    new DependencyMapDocTemplate(),
    new GettingStartedDocTemplate(),
    new GlossaryDocTemplate(),
    new ChangelogDocTemplate(opts?.redactAuthors ?? true),
  ];
}
