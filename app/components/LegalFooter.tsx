import { Link } from "react-router";
import styles from "./legal.module.css";

// Footer of the public pages: landing, privacy policy, terms, DPA (B-20).
const LegalFooter = () => (
  <footer className={styles.footer}>
    <Link to="/">Vendora</Link>
    <Link to="/privacy">Privacy policy</Link>
    <Link to="/terms">Terms of service</Link>
    <Link to="/dpa">Data processing agreement</Link>
    <a href="mailto:adhurimberisha07@gmail.com">Contact</a>
  </footer>
);

export default LegalFooter;
