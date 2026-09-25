# Antena V-dipole per a 137 MHz (satèl·lits NOAA / Meteor)

Antena barata i efectiva per rebre satèl·lits meteorològics d'òrbita baixa amb el RTL-SDR. Millor que qualsevol vareta per a aquesta banda.

## Mides
- Freqüència de disseny: **137,5 MHz** (centre de la banda NOAA/Meteor APT/LRPT).
- **Dos braços de 53,4 cm cadascun** (quart d'ona amb factor de correcció).
- Els dos braços formen una **V amb 120°** entre ells (no 90°).
- Muntatge **horitzontal**, la V oberta cap amunt (com una "V"), apuntant al cel.

## Construcció
- Serveixen dues varetes metàl·liques rígides, radis de bicicleta o filferro de coure gruixut.
- Connecta cada braç a un pol d'un **cable coaxial de 50 Ω** (RG58 o similar):
  - Un braç al conductor central.
  - L'altre braç a la malla (massa).
- Al punt d'unió, mantén els conductors separats i sòlids. Un connector SMA a l'altra punta cap al dongle.
- Opcional però recomanat: unes **voltes de coaxial** (balun d'estrangulament / choke) just sota el punt d'alimentació per reduir soroll.

## Orientació
- Deixa-la **horitzontal**, a l'exterior o en una finestra amb vista neta al cel.
- La V-dipole té bon patró per a satèl·lits que passen; no cal seguir-los.
- Orienta l'obertura de la V aproximadament **nord-sud** (els satèl·lits d'òrbita polar passen de N a S o a l'inrevés).

## Notes
- Com més amunt i lliure d'obstacles, millor. Les cases i muntanyes al voltant tallen els passos baixos.
- Els millors passos són els d'**elevació màxima alta** (>40°): més minuts de senyal i menys soroll.
