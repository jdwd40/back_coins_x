DROP DATABASE IF EXISTS coins_x_test;
DROP DATABASE IF EXISTS coins_x;

CREATE DATABASE coins_x_test;
CREATE DATABASE coins_x;

\c coins_x

ALTER DATABASE coins_x OWNER TO jd;
ALTER DATABASE coins_x_test OWNER TO jd;
