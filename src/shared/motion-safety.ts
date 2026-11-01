export type SafetyTarget = 'motor1' | 'motor2' | 'lift'
export interface AxisSafety {
  minimumMm: number | null
  maximumMm: number | null
  maxStepMm: number | null
  maxDurationMs: number | null
}
export interface MotorSafety extends AxisSafety {
  pulsesPerMm: number | null
  direction: -1 | 1 | null
  zeroPulse: number | null
  maxSpeedRpm: number | null
}
export interface LiftSafety extends AxisSafety {
  feedbackMaxAgeMs: number | null
  stopTimeoutMs: number | null
}
export interface MotionSafetyConfig {
  schemaVersion: 1
  hardwareVersion: string
  machineId: string
  reviewedBy: string
  reviewedAt: string
  evidence: Record<'emergencyCircuit' | 'disconnectProtection' | 'mechanicalLimits' | 'motorParameters' | 'liftFeedback', string>
  motor1: MotorSafety
  motor2: MotorSafety
  lift: LiftSafety
}
export interface SafetyAssessment {
  configVersion: string
  hardwareVersion: string
  bindingMatches: boolean
  evidenceVerified: false
  error: string | null
  targets: Record<SafetyTarget, { canPreview: boolean; canExecute: false; reasons: { code: string; message: string }[] }>
}
export interface SafetySnapshot { config: MotionSafetyConfig; assessment: SafetyAssessment }
export interface MotionPreview {
  mode: 'offline'
  executable: false
  target: SafetyTarget
  fromMm: number
  positionMm: number
  durationMs: number
  configVersion: string
  hardwareVersion: string
  message: string
  fromPulse?: number
  targetPulse?: number
  highWord?: number
  lowWord?: number
  speedRpm?: number
  positionAsciiCm?: string
}
