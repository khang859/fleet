export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BoxModel {
  content: { width: number; height: number };
  padding: { top: number; right: number; bottom: number; left: number };
  border: { top: number; right: number; bottom: number; left: number };
  margin: { top: number; right: number; bottom: number; left: number };
}

export interface AccessibilityInfo {
  role: string | null;
  name: string | null;
  description: string | null;
  focusable: boolean;
  disabled: boolean;
  expanded?: boolean;
  pressed?: boolean;
  checked?: boolean;
  selected?: boolean;
}

export interface ParentContext {
  tag: string;
  id?: string;
  classes: string[];
  styles: Record<string, string>;
}

export interface ElementSelection {
  selector: string;
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  rect: ElementRect;
  attributes: Record<string, string>;
  comment?: string;
  boxModel?: BoxModel;
  accessibility?: AccessibilityInfo;
  keyStyles?: Record<string, string>;
  computedStyles?: Record<string, string>;
  parentContext?: ParentContext;
  cssVariables?: Record<string, string>;
  captureScreenshot?: boolean;
}

export interface AnnotationResult {
  success: boolean;
  url?: string;
  viewport?: { width: number; height: number };
  context?: string;
  elements?: ElementSelection[];
  cancelled?: boolean;
  reason?: string;
  canvasOverlay?: string;  // Transient: drawing canvas data URL, stripped before persistence
}

export type AnnotateMode = 'select' | 'draw';

export interface AnnotateStartRequest {
  url?: string;
  timeout?: number;
  mode?: AnnotateMode;
}

export interface AnnotateCompleteResponse {
  resultPath: string;
}
