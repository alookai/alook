import { TYPEWRITER_CITY_ART } from "./typewriter-city-art-data";
import styles from "./typewriter-city-art.module.css";

export function TypewriterCityArt() {
  return (
    <div className={styles.frame} role="img" aria-label="A giant Alook sculpture in an ASCII city, surrounded by buildings, a park, and streets.">
      <pre className={styles.art} aria-hidden="true">{TYPEWRITER_CITY_ART}</pre>
    </div>
  );
}
