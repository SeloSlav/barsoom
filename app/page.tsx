import { MarsExperience } from "./components/MarsExperience";

export default function Home() {
  return <MarsExperience initialSimulationUtc={new Date().toISOString()} />;
}
